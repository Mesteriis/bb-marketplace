import { maxPhotoBytes, type TelegramPhoto } from "../../core/contract.ts";
import { readTelegramFile } from "./telegram-file.ts";

export function telegramPhotoMime(data: Buffer): TelegramPhoto["mime"] | null {
  return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? "image/jpeg"
    : data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
    : null;
}
export async function readTelegramPhoto(directory: string, path: string): Promise<TelegramPhoto> {
  const data = await readTelegramFile(directory, path, 12, maxPhotoBytes);
  const mime = telegramPhotoMime(data);
  if (!mime) throw new Error("Unsupported photo format.");
  return { mime, base64: data.toString("base64") };
}
