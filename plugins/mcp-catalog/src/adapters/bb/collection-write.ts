import { execFile } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CollectionEntry, CollectionEntryDraft, CollectionIndex, canonicalJson, sha256Hex, withIndexLine } from "../../core/collection";
import { DOCKER_PREFIX, checkDockerDigest } from "../../core/docker-catalog";
import { SLUG, isReplacementVersion } from "../../core/inventory";
import type { RegistryServer } from "../../core/registry";
import type { CollectionWritePort } from "../../core/review";

const TRAILER = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";

function git(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      if (error !== null) {
        const text = String(stderr).trim();
        reject(new Error(text.length > 0 ? text : error.message));
        return;
      }
      resolve(String(stdout));
    });
  });
}

const INDEX = "mcp-collection/index.json";
const MISSING = /exists on disk, but not in|does not exist in|path .* does not exist/;

function indexText(index: CollectionIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/** The collection index at `rev` of `repo`; a revision without one is an empty collection. */
async function indexAt(repo: string, rev: string): Promise<CollectionIndex> {
  try {
    return CollectionIndex.parse(JSON.parse(await git(repo, ["show", `${rev}:${INDEX}`])));
  } catch (error) {
    if (MISSING.test((error as Error).message)) return { servers: [] };
    throw error;
  }
}

async function commonDir(repo: string): Promise<string> {
  const out = (await git(repo, ["rev-parse", "--git-common-dir"])).trim();
  return realpath(resolve(repo, out));
}

function gitBuf(repo: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr.toString().trim() || error.message));
      else resolve(stdout);
    });
  });
}

/** Paths from `git status --porcelain -z`, renames and copies included on both sides. */
function statusPaths(out: string): string[] {
  const parts = out.split("\0").filter((part) => part !== "");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    paths.push(part.slice(3));
    if (part[0] === "R" || part[0] === "C" || part[1] === "R" || part[1] === "C") paths.push(parts[++i] ?? "");
  }
  return paths;
}

/** Writes accepted entries from a review worktree into the main checkout. */
export class CollectionWrite implements CollectionWritePort {
  constructor(private readonly marketplaceRepoPath: string) {}

  async branchHasEntry(worktree: string, slug: string): Promise<boolean> {
    try {
      const dir = join(worktree, "mcp-collection", slug);
      const serverBytes = await readFile(join(dir, "server.json"));
      await readFile(join(dir, "review.md"));
      const entry = CollectionEntryDraft.parse(JSON.parse(await readFile(join(dir, "entry.json"), "utf8")));
      if ((await sha256Hex(serverBytes)) !== entry.serverJsonSha256) return false;
      const index = CollectionIndex.parse(JSON.parse(await readFile(join(worktree, INDEX), "utf8")));
      return index.servers.some(
        (item) => item.name === entry.name && item.version === entry.version && item.path === `mcp-collection/${slug}`,
      );
    } catch {
      return false;
    }
  }

  async accept(
    worktree: string,
    slug: string,
    opts: { push: boolean; acceptedCommit?: string; expected: RegistryServer },
  ): Promise<{ commit: string }> {
    if (!SLUG.test(slug)) throw new Error("недопустимое имя сервера");
    const main = this.marketplaceRepoPath;
    const prefix = `mcp-collection/${slug}/`;

    // The worktree must belong to the main checkout's repository and not be the main checkout.
    if (
      (await commonDir(worktree)) !== (await commonDir(main)) ||
      (await realpath((await git(worktree, ["rev-parse", "--show-toplevel"])).trim())) ===
        (await realpath((await git(main, ["rev-parse", "--show-toplevel"])).trim()))
    ) {
      throw new Error("путь проверки — не рабочее дерево основной копии bb-main");
    }
    if (!(await this.branchHasEntry(worktree, slug))) throw new Error("в рабочем дереве нет полной записи коллекции");

    const branch = (await git(main, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch !== "main" || (await git(main, ["status", "--porcelain"])).trim() !== "") {
      throw new Error("основная копия bb-main не на main или с незакоммиченными правками");
    }
    await git(main, ["fetch", "origin", "main"]);
    if ((await git(main, ["rev-parse", "main"])).trim() !== (await git(main, ["rev-parse", "origin/main"])).trim()) {
      throw new Error("локальный main не совпадает с origin/main: сначала синхронизируйте основную копию");
    }

    const draft = CollectionEntryDraft.parse(JSON.parse(await readFile(join(worktree, prefix, "entry.json"), "utf8")));
    if (draft.name !== opts.expected.name || draft.version !== opts.expected.version) {
      throw new Error("запись в рабочем дереве не та, что проверялась: имя или версия другие");
    }
    const line = { name: draft.name, version: draft.version, path: `mcp-collection/${slug}` };
    const subject = `mcp-collection: accept ${draft.name} ${draft.version}`;
    const head = (await git(worktree, ["rev-parse", "HEAD"])).trim();

    // The reviewer was told not to commit. The only commit allowed is our own from an earlier
    // attempt, recognised by the SHA recorded back then, never by its message.
    const own = (await git(worktree, ["rev-list", "main..HEAD"])).split("\n").filter((line) => line !== "");
    const retry = own.length > 0;
    if (retry && !(own.length === 1 && opts.acceptedCommit !== undefined && opts.acceptedCommit === head)) {
      throw new Error("в ветке проверки есть посторонние коммиты");
    }

    if (retry) {
      // Main may have taken other entries since our commit: rebuild the index line on today's main and amend,
      // so that the owner never has to work out why a retry fails.
      const rebuilt = indexText(withIndexLine(await indexAt(main, "main"), line));
      if ((await git(worktree, ["show", `HEAD:${INDEX}`])) !== rebuilt) {
        await writeFile(join(worktree, INDEX), rebuilt);
        await git(worktree, ["add", "--", INDEX]);
        await git(worktree, ["commit", "--amend", "--no-edit", "--", INDEX]);
      }
    } else {
      const changed = [
        ...(await git(worktree, ["diff", "--name-only", "main...HEAD"])).split("\n"),
        ...statusPaths(await git(worktree, ["status", "--porcelain=v1", "-z", "-uall"])),
      ];
      // The reviewer's index is judged against the main it started from ...
      const forkPoint = (await git(worktree, ["merge-base", "main", "HEAD"])).trim();
      await this.checkTree(slug, changed, (path) => readFile(join(worktree, path)), await indexAt(worktree, forkPoint), opts.expected, false);
      // ... and then rebuilt on today's main, so that an entry accepted meanwhile does not block this one.
      await writeFile(join(worktree, INDEX), indexText(withIndexLine(await indexAt(main, "main"), line)));
      const entryPath = join(worktree, prefix, "entry.json");
      const entry = CollectionEntry.parse({ ...JSON.parse(await readFile(entryPath, "utf8")), acceptedAt: new Date().toISOString() });
      await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);
      await git(worktree, ["add", "--", `mcp-collection/${slug}`, INDEX]);
      await git(worktree, ["commit", "-m", `${subject}\n\n${TRAILER}`, "--", `mcp-collection/${slug}`, INDEX]);
    }
    const sha = (await git(worktree, ["rev-parse", "HEAD"])).trim();
    const fail = (message: string, cause?: unknown): never => {
      throw Object.assign(new Error(message, { cause }), { acceptCommit: sha });
    };

    // Everything is checked again against the committed tree, which is what gets merged.
    try {
      const committed = (await git(worktree, ["diff", "--name-only", "main...HEAD"])).split("\n");
      await this.checkTree(slug, committed, (path) => gitBuf(worktree, ["show", `HEAD:${path}`]), await indexAt(main, "main"), opts.expected, true);
      if ((await git(worktree, ["status", "--porcelain", "-uall"])).trim() !== "") {
        throw new Error("рабочее дерево проверки не чистое: слияние отменено");
      }
    } catch (error) {
      return fail((error as Error).message, error);
    }

    // The index is the one file two accepted entries both touch: the merge result takes main's index with
    // this entry's line put in, whatever git made of it. Any other conflict aborts the merge.
    const merged = indexText(withIndexLine(await indexAt(main, "main"), line));
    let step = "слияние";
    let conflict = false;
    try {
      await git(main, ["merge", "--no-ff", "--no-commit", sha]).catch(async (error: unknown) => {
        const conflicted = (await git(main, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter((path) => path !== "");
        if (conflicted.length > 0 && conflicted.some((path) => path !== INDEX)) conflict = true;
        if (conflicted.length === 0 || conflict) throw error;
      });
      step = "запись индекса";
      await writeFile(join(main, INDEX), merged);
      await git(main, ["add", "--", INDEX]);
      step = "коммит слияния";
      await git(main, ["commit", "--no-edit", "-m", `Merge mcp-collection ${slug}`]);
    } catch (error) {
      const inProgress = await git(main, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false);
      if (inProgress) await git(main, ["merge", "--abort"]);
      if (conflict) return fail("не удалось слить запись коллекции: конфликт", error);
      return fail(`не удалось слить запись коллекции (шаг «${step}»): ${(error as Error).message}`, error);
    }
    if (opts.push) {
      try {
        await git(main, ["push", "origin", "main"]);
      } catch (error) {
        return fail(
          `запись влита в локальный main, но не отправлена в origin: выполните git push вручную (${(error as Error).message})`,
          error,
        );
      }
    }
    return { commit: sha };
  }

  /**
   * Path bounds, entry/index agreement, the server.json hash and its equality with the registry record, and
   * the index change against `before`: every other line unchanged, and this server's line either new or
   * replacing its own line with a newer version.
   */
  private async checkTree(
    slug: string,
    changedPaths: string[],
    read: (path: string) => Promise<Buffer>,
    before: CollectionIndex,
    expected: RegistryServer,
    committed: boolean,
  ): Promise<void> {
    const prefix = `mcp-collection/${slug}/`;
    const outside = [...new Set(changedPaths)].filter((path) => path !== "" && !path.startsWith(prefix) && path !== INDEX);
    if (outside.length > 0) throw new Error(`в рабочем дереве есть изменения вне записи коллекции: ${outside.join(", ")}`);

    const serverBytes = await read(`${prefix}server.json`);
    await read(`${prefix}review.md`);
    const raw = JSON.parse((await read(`${prefix}entry.json`)).toString("utf8"));
    const draft = CollectionEntryDraft.parse(raw);
    if (committed) CollectionEntry.parse(raw);
    if (draft.name !== expected.name || draft.version !== expected.version) {
      throw new Error("запись в рабочем дереве не та, что проверялась: имя или версия другие");
    }
    if (expected.name.startsWith(DOCKER_PREFIX) && draft.choice.kind === "package") checkDockerDigest(expected, draft.ociDigest);
    if ((await sha256Hex(serverBytes)) !== draft.serverJsonSha256) throw new Error("хэш server.json не совпадает с entry.json");
    if (canonicalJson(JSON.parse(serverBytes.toString("utf8"))) !== canonicalJson(expected)) {
      throw new Error("server.json не совпадает с записью реестра для этой версии");
    }

    const after = CollectionIndex.parse(JSON.parse((await read(INDEX)).toString("utf8")));
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const othersBefore = before.servers.filter((item) => item.name !== draft.name);
    const othersAfter = after.servers.filter((item) => item.name !== draft.name);
    const mineBefore = before.servers.filter((item) => item.name === draft.name);
    const mineAfter = after.servers.filter((item) => item.name === draft.name);
    const line = { name: draft.name, version: draft.version, path: `mcp-collection/${slug}` };
    const othersKept =
      othersAfter.length === othersBefore.length && othersBefore.every((old) => othersAfter.some((item) => same(item, old)));
    if (!othersKept || mineBefore.length > 1 || mineAfter.length !== 1 || !same(mineAfter[0], line)) {
      throw new Error("индекс коллекции должен отличаться от main одной строкой этого сервера: новой или заменённой более новой версией");
    }
    const previous = mineBefore[0];
    if (previous !== undefined && !isReplacementVersion(draft.name, draft.version, previous.version)) {
      throw new Error(`в коллекции уже есть версия ${previous.version}: принять можно только более новую`);
    }
  }

  async reject(): Promise<void> {
    // Nothing destructive here: archiving the thread and its worktree is a later owner action.
  }
}
