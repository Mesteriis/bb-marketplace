import { checksum, scanFile } from "./compare.ts";
import { CommanderError } from "./errors.ts";
import type { Fingerprint } from "./model.ts";
import type { ResourcePath } from "./path.ts";
import type { FileProvider } from "./provider.ts";
import { createTransferHash, fingerprint, matches, readChunks } from "./reconcile.ts";
import { toBig } from "./size.ts";

export const EDIT_LIMIT = 16 * 1024 * 1024;
export const EDIT_CHUNK = 1024 * 1024;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

export function editTextValidator() {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return (bytes?: Uint8Array) => {
    let text: string;
    try { text = decoder.decode(bytes, { stream: bytes !== undefined }); }
    catch { throw nonText(); }
    if (CONTROL.test(text)) throw nonText();
  };
}

function nonText() {
  return new CommanderError("unsupported", "Файл не текстовый — правка недоступна");
}

export function checkEditSize(size: Fingerprint["size"]) {
  if (toBig(size) > BigInt(EDIT_LIMIT)) {
    throw new CommanderError("limit_exceeded", "Файл слишком большой для правки (до 16 МиБ)");
  }
}

export async function readEditSource(
  provider: FileProvider, path: ResourcePath, signal: AbortSignal,
  { expected, chunkBytes = EDIT_CHUNK }: { expected?: Fingerprint; chunkBytes?: number } = {},
): Promise<{ base: Fingerprint; chunks: Uint8Array[] }> {
  const location = { provider, path };
  const entry = await scanFile(location, signal);
  const base = fingerprint(entry)!;
  checkEditSize(base.size);

  const changed = new CommanderError("changed_since_plan", "Файл изменился во время открытия");
  if (expected && !matches(base, expected)) throw changed;

  const validate = editTextValidator();
  const hash = provider.sha256 ? createTransferHash() : undefined;
  const chunks: Uint8Array[] = [];
  await readChunks(location, base, chunkBytes, signal, async (call) => {
    signal.throwIfAborted();
    return call();
  }, async (bytes) => {
    validate(bytes);
    hash?.update(bytes);
    chunks.push(bytes);
  });
  validate();

  const after = await provider.stat(path, signal);
  signal.throwIfAborted();
  if (after?.kind !== "file" || !matches(after, base)) throw changed;
  if (hash) {
    const actual = hash.finish();
    if (await checksum(provider, path, signal, { expected: after }) !== actual) throw changed;
    base.sha256 = actual;
  }
  return { base, chunks };
}
