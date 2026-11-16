import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { maxPhotoBytes, maxPhotoEdge } from "../../core/contract.ts";

export function inspectJpeg(base64: string) {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > maxPhotoBytes || bytes.toString("base64") !== base64
    || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return;
  for (let pos = 2; pos + 4 < bytes.length;) {
    if (bytes[pos++] !== 0xff) return;
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    if (marker === 0xda || pos + 2 > bytes.length) return;
    const size = bytes.readUInt16BE(pos);
    if (size < 2 || pos + size > bytes.length) return;
    if ([0xc0, 0xc1, 0xc2].includes(marker!)) {
      if (size < 8) return;
      const height = bytes.readUInt16BE(pos + 3);
      const width = bytes.readUInt16BE(pos + 5);
      return width > 0 && height > 0 && width <= maxPhotoEdge && height <= maxPhotoEdge ? { bytes, width, height } : undefined;
    }
    pos += size;
  }
}

type Upload = { body: ReadableStream<Uint8Array>; size: number };

async function writeUpload(path: string, { body, size }: Upload) {
  const file = await open(path, "wx", 0o600);
  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > size) throw new Error("Upload exceeded its declared size.");
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
        if (!bytesWritten) throw new Error("Could not write the upload.");
        offset += bytesWritten;
      }
      total += value.byteLength;
    }
    if (total !== size) throw new Error("Upload did not match its declared size.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await file.close();
  }
}

export async function stageAttachment(sessionDirectory: string, bytes: Buffer | Upload, name: string, kind: "photo" | "document") {
  const staging = join(sessionDirectory, `makosh-outgoing-${kind}s`);
  await mkdir(staging, { mode: 0o700, recursive: true });
  let retained = 0;
  for (const entry of await readdir(staging, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(kind + "-") || !/^[a-zA-Z0-9]{6}$/.test(entry.name.slice(kind.length + 1))) continue;
    const folder = join(staging, entry.name);
    try {
      if ((await stat(folder)).mtimeMs < Date.now() - 24 * 60 * 60_000) await rm(folder, { recursive: true, force: true });
      else retained++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (retained >= 16) throw new Error("Too many unconfirmed uploads.");
  const folder = await mkdtemp(join(staging, kind + "-"));
  const path = join(folder, name);
  const dispose = () => rm(folder, { recursive: true, force: true });
  try {
    if (Buffer.isBuffer(bytes)) await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    else await writeUpload(path, bytes);
    return { path, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
