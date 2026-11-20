import { maxStaticStickerBytes, maxStickerCoverBytes } from "../core/contract.ts";

export const stickerImageAccept = "image/png,image/webp,image/jpeg";
const maxOriginalStickerBytes = 16 * 1024 * 1024;

export async function prepareStickerImage(file: File, kind: "sticker" | "cover" = "sticker"): Promise<string> {
  if (!stickerImageAccept.split(",").includes(file.type) || file.size < 1 || file.size > maxOriginalStickerBytes) {
    throw new Error("Choose a PNG, WebP or JPEG image up to 16 MiB.");
  }
  const image = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  try {
    const cover = kind === "cover";
    const scale = (cover ? 100 : 512) / Math.max(image.width, image.height);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    canvas.width = cover ? 100 : width;
    canvas.height = cover ? 100 : height;
    const context = canvas.getContext("2d");
    if (!context || !image.width || !image.height) throw new Error("Could not decode the sticker image.");
    context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    for (const quality of [0.95, 0.8, 0.6]) {
      const url = canvas.toDataURL("image/webp", quality);
      const match = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
      if (!match?.[1]) break;
      const base64 = match[1];
      const size = base64.length / 4 * 3 - (base64.match(/=+$/)?.[0].length ?? 0);
      if (size <= (cover ? maxStickerCoverBytes : maxStaticStickerBytes)) return base64;
    }
    throw new Error("Could not prepare a WebP sticker.");
  } finally {
    image.close();
    canvas.width = canvas.height = 0;
  }
}
