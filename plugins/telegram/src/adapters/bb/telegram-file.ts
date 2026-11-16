import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { Readable } from "node:stream";
import { isAbsolute, relative, sep } from "node:path";

async function openTelegramFile(directory: string, path: string, minimum: number, maximum: number) {
  const root = await realpath(directory);
  const target = await realpath(path);
  const within = relative(root, target);
  if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) {
    throw new Error("File is outside the TDLib directory.");
  }

  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const meta = await file.stat();
    if (!meta.isFile() || meta.size < minimum || meta.size > maximum) throw new Error("Invalid Telegram file size.");
    return { file, size: meta.size };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function readTelegramFile(directory: string, path: string, minimum: number, maximum: number): Promise<Buffer> {
  const { file, size } = await openTelegramFile(directory, path, minimum, maximum);
  try {
    const data = Buffer.alloc(size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error("File changed while reading.");
      offset += bytesRead;
    }
    return data;
  } finally {
    await file.close();
  }
}

export async function streamTelegramFile(directory: string, path: string, maximum: number) {
  const { file, size } = await openTelegramFile(directory, path, 0, maximum);
  if (size === 0) {
    await file.close();
    return { size, body: null };
  }
  const chunkSize = 64 * 1024;
  const readable = file.createReadStream({ start: 0, end: size - 1, highWaterMark: chunkSize });
  const body = Readable.toWeb(readable, {
    strategy: { highWaterMark: chunkSize, size: (chunk: Uint8Array) => chunk.byteLength },
  }) as ReadableStream<Uint8Array<ArrayBuffer>>;
  return { size, body };
}
