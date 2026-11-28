import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { CommanderError } from "../../core/errors.ts";
import { EDIT_CHUNK, EDIT_LIMIT, editTextValidator } from "../../core/edit-source.ts";

export const EDIT_DIRECTORY = "commander-edits";
const UPLOAD_TTL = 10 * 60 * 1000;
const QUOTA = 1024 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const leafPattern = /^(?:revision|upload)-[0-9]+$|^snapshot-[0-9a-f-]{36}$/;

type CopyLeaf = { revision: number } | { snapshotId: string } | { upload: number };

function identifier(value: string) {
  if (!uuid.test(value)) throw new CommanderError("invalid_path", "Invalid edit identifier");
  return value;
}

function requireIndex(index: number) {
  if (!Number.isSafeInteger(index) || index < 0) throw new CommanderError("invalid_path", "Invalid edit index");
  return index;
}

function leafName(value: CopyLeaf) {
  if ("snapshotId" in value) return "snapshot-" + identifier(value.snapshotId);
  return "revision" in value ? "revision-" + requireIndex(value.revision) : "upload-" + requireIndex(value.upload);
}

async function metadata(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function directory(path: string) {
  if (!(await metadata(path))?.isDirectory()) throw new CommanderError("not_found", "Сеанс завершён — откройте файл снова");
  return path;
}

async function regular(path: string, flags: number) {
  const file = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(EDIT_LIMIT)) {
      throw new CommanderError("unsupported", "Invalid private edit file");
    }
    return { file, stat };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function remove(path: string) {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function writeNew(path: string, bytes: Uint8Array) {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } catch (error) {
    await remove(path);
    throw error;
  } finally {
    await file.close();
  }
}

export function createEditFiles({ quotaBytes = QUOTA, now = Date.now } = {}) {
  // The host SDK runs one worker for this plugin on a host. Serialize quota
  // inspection and file mutations within the worker.
  let tail = Promise.resolve();
  function transaction<T>(action: () => Promise<T>) {
    const result = tail.then(action);
    tail = result.then(() => {}, () => {});
    return result;
  }

  async function sessionPath(dataDir: string, id: string) {
    const root = await directory(join(dataDir, EDIT_DIRECTORY));
    return directory(join(root, identifier(id)));
  }

  async function reserve(dataDir: string, added: number) {
    const root = await directory(join(dataDir, EDIT_DIRECTORY));
    let used = 0;
    for (const id of await readdir(root, { withFileTypes: true })) {
      if (!id.isDirectory() || !uuid.test(id.name)) continue;
      for (const file of await readdir(join(root, id.name), { withFileTypes: true })) {
        if (!file.isFile() || !leafPattern.test(file.name)) continue;
        used += (await metadata(join(root, id.name, file.name)))?.size ?? 0;
      }
    }
    if (used + added > quotaBytes) throw new CommanderError("limit_exceeded", "Исчерпана квота правки (1 ГиБ)");
  }

  async function discardStale(path: string, base?: number) {
    for (const item of await readdir(path)) {
      if (!/^upload-[0-9]+$/.test(item)) continue;
      const upload = join(path, item);
      const info = await metadata(upload);
      if (info && (now() - info.mtimeMs >= UPLOAD_TTL || base !== undefined && item !== "upload-" + base)) {
        await remove(upload);
      }
    }
  }

  async function readWhole(path: string) {
    const { file, stat } = await regular(path, constants.O_RDONLY);
    try {
      const bytes = await file.readFile();
      if (BigInt(bytes.length) !== stat.size) throw new CommanderError("changed_since_plan", "Private edit file changed");
      return { bytes, stat };
    } finally { await file.close(); }
  }

  return {
    create(dataDir: string, id: string, plannedBytes = 0) {
      return transaction(async () => {
        const root = join(dataDir, EDIT_DIRECTORY);
        await mkdir(root, { recursive: true, mode: 0o700 });
        await reserve(dataDir, plannedBytes);
        const path = join(root, identifier(id));
        await mkdir(path, { mode: 0o700 });
        const file = join(path, "revision-0");
        await writeNew(file, new Uint8Array());
        return file;
      });
    },
    readChunk(dataDir: string, id: string, source: CopyLeaf, offset: number, length: number) {
      return transaction(async () => {
        requireIndex(offset);
        if (!Number.isInteger(length) || length < 1 || length > EDIT_CHUNK) {
          throw new CommanderError("limit_exceeded", "Invalid edit read length");
        }
        const path = join(await sessionPath(dataDir, id), leafName(source));
        const { file, stat } = await regular(path, constants.O_RDONLY);
        try {
          if (offset > Number(stat.size)) throw new CommanderError("invalid_path", "Invalid edit read offset");
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await file.read(buffer, 0, length, offset);
          return { bytes: buffer.subarray(0, bytesRead).toString("base64"), eof: offset + bytesRead === Number(stat.size) };
        } finally { await file.close(); }
      });
    },
    writeChunk(dataDir: string, id: string, base: number, offset: number, bytes: Uint8Array) {
      return transaction(async () => {
        requireIndex(offset);
        if (bytes.byteLength > EDIT_CHUNK || offset + bytes.byteLength > EDIT_LIMIT) {
          throw new CommanderError("limit_exceeded", "Файл слишком большой для правки (до 16 МиБ)");
        }
        const folder = await sessionPath(dataDir, id);
        await discardStale(folder);
        const path = join(folder, leafName({ upload: base }));
        const previous = await metadata(path);
        if (previous && (!previous.isFile() || previous.nlink !== 1)) {
          throw new CommanderError("unsupported", "Invalid private edit upload");
        }
        if (offset !== 0 && offset !== previous?.size) {
          throw new CommanderError("changed_since_plan", "Неверное смещение порции");
        }
        await reserve(dataDir, offset === 0 ? bytes.byteLength - (previous?.size ?? 0) : bytes.byteLength);
        if (offset === 0) {
          await remove(path);
          await writeNew(path, bytes);
        } else {
          const { file } = await regular(path, constants.O_WRONLY | constants.O_APPEND);
          try {
            await file.writeFile(bytes).catch(async (error) => {
              await file.truncate(offset);
              throw error;
            });
          } finally { await file.close(); }
        }
        await utimes(path, new Date(now()), new Date(now()));
      });
    },
    commitRevision(dataDir: string, id: string, base: number, digest: string, initial = false) {
      return transaction(async () => {
        const folder = await sessionPath(dataDir, id);
        await discardStale(folder, base);
        const upload = join(folder, leafName({ upload: base }));
        const next = initial ? 0 : base + 1;
        const revision = join(folder, leafName({ revision: next }));
        const hasUpload = await metadata(upload) !== null;
        const { bytes } = await readWhole(hasUpload ? upload : revision);
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (hash !== digest) throw new CommanderError("changed_since_plan", "SHA-256 редакции не совпадает");
        const validate = editTextValidator();
        validate(bytes);
        validate();
        await reserve(dataDir, 0);
        if (hasUpload) await rename(upload, revision);
        return next;
      });
    },
    snapshot(dataDir: string, id: string, revision: number, snapshotId: string) {
      return transaction(async () => {
        const folder = await sessionPath(dataDir, id);
        const path = join(folder, leafName({ snapshotId }));
        const { bytes } = await readWhole(join(folder, leafName({ revision })));
        await reserve(dataDir, bytes.length);
        await writeNew(path, bytes);
        const { file, stat } = await regular(path, constants.O_RDONLY);
        await file.close();
        return { size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(), sha256: createHash("sha256").update(bytes).digest("hex") };
      });
    },
    route(dataDir: string, id: string, revision: number) {
      return transaction(async () => {
        const path = join(await sessionPath(dataDir, id), leafName({ revision }));
        const { file } = await regular(path, constants.O_RDONLY);
        await file.close();
        return path;
      });
    },
    inspectSnapshot(dataDir: string, id: string, snapshotId: string) {
      return transaction(async () => {
        const root = join(dataDir, EDIT_DIRECTORY);
        const folder = join(root, identifier(id));
        if (!(await metadata(root))?.isDirectory() || !(await metadata(folder))?.isDirectory()) return null;
        const path = join(folder, leafName({ snapshotId }));
        if (!await metadata(path)) return null;
        const { bytes, stat } = await readWhole(path);
        return { size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(), sha256: createHash("sha256").update(bytes).digest("hex") };
      });
    },
    sweep(dataDir: string, held: { sessionId: string; revision?: number; upload?: number; snapshots: string[] }[]) {
      return transaction(async () => {
        const root = join(dataDir, EDIT_DIRECTORY);
        if (!(await metadata(root))?.isDirectory()) return;
        const keeps = new Map(held.map((record) => [record.sessionId, record]));
        for (const child of await readdir(root, { withFileTypes: true })) {
          if (!child.isDirectory() || !uuid.test(child.name)) continue;
          const folder = await directory(join(root, child.name));
          const hold = keeps.get(child.name);
          const retained = new Set([
            ...(hold?.revision === undefined ? [] : [leafName({ revision: hold.revision })]),
            ...(hold?.upload === undefined ? [] : [leafName({ upload: hold.upload })]),
            ...(hold?.snapshots ?? []).map((snapshotId) => leafName({ snapshotId })),
          ]);
          await discardStale(folder);
          for (const leaf of await readdir(folder, { withFileTypes: true })) {
            if (leafPattern.test(leaf.name) && !leaf.isDirectory() && !retained.has(leaf.name)) {
              await remove(join(folder, leaf.name));
            }
          }
          if (!hold && (await readdir(folder)).length === 0) await rmdir(folder);
        }
      });
    },
    discardStaleUpload(dataDir: string, id: string, base?: number) {
      return transaction(async () => discardStale(await sessionPath(dataDir, id), base));
    },
    delete(dataDir: string, id: string, leaf: CopyLeaf) {
      return transaction(async () => remove(join(await sessionPath(dataDir, id), leafName(leaf))));
    },
  };
}
