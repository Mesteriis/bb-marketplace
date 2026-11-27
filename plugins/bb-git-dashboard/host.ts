import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/adapters/bb/host-contract.ts";
import { failureFor } from "./src/core/workspace.ts";
import { sshHostname } from "./src/adapters/bb/ssh-config.ts";
import { commitDetails, commitPatch, historyPage, historyRevision, workingPatch } from "./src/adapters/bb/history-git.ts";
import { probeForge } from "./src/adapters/bb/forge-probe.ts";
import { createRunGit, defaultBase, diff as reviewDiff, GitError, listFiles, recentCommits } from "./src/adapters/bb/review-git.ts";
import type { Target } from "./src/core/code-review/model.ts";
import { readReviewFile, writeReviewFile } from "./src/adapters/bb/review-files.ts";
import { GIT_DIR_IGNORED, WATCH_IGNORED, WatchLeases, watchedFolders } from "./src/adapters/bb/review-watch.ts";
import { ignoreFor } from "./src/adapters/bb/review-ignore.ts";
import { revertShown } from "./src/adapters/bb/review-revert.ts";
import { hostSignals } from "./src/adapters/bb/host-contract.ts";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";

import { walkProjects } from "./src/adapters/bb/project-walk.ts";
import { maxDepth } from "./src/core/catalog/project-scan.ts";
import { isAbsolute } from "node:path";
import { assertWorktree, originUrl, cloneHttps, cloneLocal, exchangeHttps, localGit, worktreeIdentity } from "./src/adapters/bb/local-git.ts";

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

/** The watches of copies whose Review is open; built on the first renewal, with that call's context. */
let leases: WatchLeases | null = null;
let sweeper: ReturnType<typeof setInterval> | null = null;
function watchLeases(context: ExperimentalHostRpcContext<typeof hostSignals>) {
  // Leases that ran out end even when no Review renews anything any more.
  sweeper ??= setInterval(() => leases?.sweep(), 30_000);
  sweeper.unref?.();
  leases ??= new WatchLeases(
    async (root, listener) => {
      // A linked worktree's index and HEAD (and the refs) live in git directories outside it: those are watched too.
      const run = createRunGit(10_000);
      const dir = async (flag: string) => (await run(root, ["rev-parse", flag], {allowFailure: true})).stdout.trim() || null;
      const common = await dir("--git-common-dir");
      const folders = watchedFolders(root, await dir("--absolute-git-dir"), common && (isAbsolute(common) ? common : resolve(root, common)));
      const watches = await Promise.all(folders.map(folder => context.experimental_watch({rootPath: folder, ignoredPaths: folder === root ? WATCH_IGNORED : folder === folders.at(-1) && folders.length > 2 ? [...GIT_DIR_IGNORED, "index"] : GIT_DIR_IGNORED,
        debounceMs: 400, maxWaitMs: 2000}, listener)));
      return {dispose: async () => { await Promise.all(watches.map(watch => watch.dispose())); }};
    },
    root => { void context.experimental_emitSignal("reviewCopyChanged", {root}).catch(() => { /* the next change tries again */ }); });
  return leases;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  dispose: async () => { if (sweeper) clearInterval(sweeper); leases?.stopAll(); },
  handlers: {
    async reviewCommits({root, identity}, {signal}) {
      try {
        await assertWorktree(root, identity, signal);
        return {ok: true as const, commits: await recentCommits(createRunGit(60_000, signal), root)};
      } catch (error) { return failureFor(error, "GIT_REJECTED"); }
    },
    async reviewFiles({root, identity, query}, {signal}) {
      try {
        await assertWorktree(root, identity, signal);
        return {ok: true as const, ...await listFiles(createRunGit(60_000, signal), root, query)};
      } catch (error) { return failureFor(error, "GIT_REJECTED"); }
    },
    async reviewRevert({root, identity, path, revision, hunks}, {signal}) {
      try {
        await assertWorktree(root, identity, signal);
        await revertShown(createRunGit(60_000, signal), root, path, revision, hunks);
        return {ok: true as const};
      } catch (error) { return failureFor(error, "OUTCOME_UNKNOWN"); }
    },
    async reviewWatch({root, identity}, context) {
      try {
        await assertWorktree(root, identity, context.signal);
        await watchLeases(context).renew(root);
        return {ok: true as const};
      } catch (error) { return failureFor(error, "HOST_UNAVAILABLE"); }
    },
    async trash({root,identity},{signal}) {
      try {
        if (process.platform !== "darwin") throw new Error("TRASH_UNAVAILABLE");
        if ([homedir(),process.cwd()].some(path => path === root || path.startsWith(root + sep)) || root === sep)
          throw new Error("PROTECTED_FOLDER");
        const trees = await localGit(root,{kind:"worktrees"},signal);
        if (trees.worktrees?.length !== 1 || resolve(trees.worktrees[0].path) !== root)
          throw new Error("SHARED_WORKTREE");
        await assertWorktree(root,identity,signal,true);
        await promisify(execFile)("/usr/bin/trash",[root],{signal});
        return {ok:true as const};
      } catch (error) { return failureFor(error,"TRASH_FAILED"); }
    },
    async validate({root}, {signal}) {
      try { return {ok: true as const, ...await worktreeIdentity(root, signal, true)}; }
      catch (error) { return failureFor(error, "INVALID_WORKTREE"); }
    },
    async git({root, identity, action}, {signal}) {
      try {
        await assertWorktree(root,identity,signal,action.kind === "worktrees");
        return {ok: true as const, value: await localGit(root, action, signal)};
      }
      catch (error) { return failureFor(error, "GIT_REJECTED"); }
    },
    async cloneHttps({clone, username, destination}, {signal}) {
      try {
        const root = await cloneHttps(clone,username,destination,signal);
        return {ok:true as const,...await worktreeIdentity(root,signal)};
      }
      catch (error) { return failureFor(error,"GIT_REJECTED"); }
    },
    async exchangeHttps({clone, username, root, identity, action}, {signal}) {
      try {
        await assertWorktree(root,identity,signal);
        return {ok:true as const, value:await exchangeHttps(root, clone, username, action, signal)};
      }
      catch (error) { return failureFor(error,"GIT_REJECTED"); }
    },
    async originUrl({root, identity}, {signal}) {
      try {
        await assertWorktree(root,identity,signal);
        return {ok:true as const, url:await originUrl(root,signal)};
      }
      catch (error) { return failureFor(error,"NO_ORIGIN"); }
    },
    async scanProjects({root, exclude}, {signal}) {
      try {
        const folder = root === "~" || root.startsWith("~/") ? homedir() + root.slice(1) : root;
        if (!isAbsolute(folder)) throw new Error("INVALID_PATH");
        const result = await walkProjects(folder,{exclude,maxDepth},undefined,signal);
        return {ok:true as const, verdicts:result.verdicts.slice(0,20_000), truncated:result.truncated || result.verdicts.length > 20_000};
      }
      catch (error) { return failureFor(error,"INVALID_PATH"); }
    },
    async probeForge({origin}) {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search) return {kind:null};
      return {kind:await probeForge(url.origin)};
    },
    async historyPage({root, identity, offset, limit}, {signal}) {
      try { await assertWorktree(root,identity,signal); return {ok:true as const, value:await historyPage(root,offset,limit,signal)}; }
      catch (error) { return failureFor(error,"GIT_REJECTED"); }
    },
    async historyRevision({root, identity}, {signal}) {
      try { await assertWorktree(root,identity,signal); return {ok:true as const, revision:await historyRevision(root,signal)}; }
      catch (error) { return failureFor(error,"GIT_REJECTED"); }
    },
    async historyCommit({root, identity, hash}, {signal}) {
      try { await assertWorktree(root,identity,signal); return {ok:true as const, value:await commitDetails(root,hash,signal)}; }
      catch (error) { return failureFor(error,"GIT_REJECTED"); }
    },
    async reviewDiff({root, identity, target, ignoreWhitespace, patches, paths, ignore}, {signal}) {
      try {
        await assertWorktree(root,identity,signal);
        const reviewGit = createRunGit(60_000, signal);
        // The branch views without a base compare against the copy's default branch.
        let resolved: Target;
        if ((target.kind === "branch" || target.kind === "all") && !target.base) {
          const base = await defaultBase(reviewGit, root);
          if (!base) throw new GitError("Unknown revision 'main'.");
          resolved = {kind: target.kind, base};
        } else resolved = target as Target;
        const ignored = ignore ? await ignoreFor(reviewGit, root, ignore.patterns, ignore.readFiles) : null;
        const value = await reviewDiff(reviewGit, root, resolved, ignoreWhitespace, {patches, paths, ignored});
        // A commit's review is kept under its full hash, however short the hash it was asked by.
        return {ok:true as const, value, target:resolved.kind === "commit" && value.headSha ? {kind:"commit" as const, sha:value.headSha} : resolved};
      } catch (error) {
        // diff-review's git reports in sentences; the plugin answers in codes.
        const unknown = error instanceof GitError && /^Unknown revision|no common ancestor/.test(error.message);
        return failureFor(unknown ? new Error("UNKNOWN_REVISION") : error, error instanceof GitError && error.message.includes("too large") ? "GIT_OUTPUT_LIMIT" : "GIT_REJECTED");
      }
    },
    async reviewFile({root, identity, path}, {signal}) {
      try { await assertWorktree(root,identity,signal); return {ok:true as const, ...await readReviewFile(root,path)}; }
      catch (error) { return failureFor(error,"INVALID_PATH"); }
    },
    async reviewWrite({root, identity, path, expected, text}, {signal}) {
      try { await assertWorktree(root,identity,signal); return {ok:true as const, ...await writeReviewFile(root,path,expected,text)}; }
      catch (error) { return failureFor(error,"OUTCOME_UNKNOWN"); }
    },
    async historyPatch({root, identity, hash, path}, {signal}) {
      try {
        await assertWorktree(root,identity,signal);
        return {ok:true as const, value:hash === null ? await workingPatch(root,path,signal) : await commitPatch(root,hash,path,signal)};
      }
      catch (error) { return failureFor(error,"GIT_REJECTED"); }
    },
    async sshHostname({alias}) {
      try { return {ok:true as const, hostname:await sshHostname(alias)}; }
      catch (error) { return failureFor(error,"SSH_CONFIG_UNAVAILABLE"); }
    },
    async cloneLocal({source, destination}, {signal}) {
      try {
        const root = await cloneLocal(source,destination,signal);
        return {ok:true as const,...await worktreeIdentity(root,signal)};
      }
      catch (error) { return failureFor(error, "GIT_REJECTED"); }
    },
  },
});
