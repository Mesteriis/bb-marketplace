import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export function readCredentials(path: string | undefined) {
  if (!path) throw new Error("Set MAKOSH_TELEGRAM_CREDENTIALS_FILE on the BB server.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 8192) {
      throw new Error("Invalid Telegram credential file permissions.");
    }
    const buffer = Buffer.alloc(8193);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 8192) throw new Error("Invalid Telegram credential file.");
    const entries = buffer.subarray(0, length).toString().split(/\r?\n/).filter((line) => line.trim());
    const id = entries.find((line) => /^MAKOSH_TELEGRAM_API_ID=\d{1,10}$/.test(line))?.split("=")[1];
    const apiHash = entries.find((line) => /^MAKOSH_TELEGRAM_API_HASH=[\da-f]{32}$/i.test(line))?.split("=")[1];
    const apiId = Number(id);
    if (entries.length !== 2 || !(apiId > 0 && apiId <= 2147483647) || !apiHash) {
      throw new Error("Invalid Telegram app credentials.");
    }
    return { apiId, apiHash };
  } finally {
    closeSync(fd);
  }
}
