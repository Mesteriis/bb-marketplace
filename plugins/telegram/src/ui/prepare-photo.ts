import { maxPhotoBytes, maxPhotoEdge } from "../core/contract.ts";

const photoMimeTypes = ["image/jpeg", "image/png", "image/webp"];
export const photoAccept = photoMimeTypes.join(",");
export const isPhotoMimeType = (type: string) => photoMimeTypes.includes(type);
export const maxOriginalPhotoBytes = 64 * 1024 * 1024;

export async function preparePhoto(file: File, cropSquare = false): Promise<string> {
  const image = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  try {
    const context = canvas.getContext("2d");
    if (!context || !image.width || !image.height) throw new Error("Could not decode this photo.");
    const width = cropSquare ? Math.min(image.width, image.height) : image.width;
    const height = cropSquare ? width : image.height;
    for (const maxEdge of [maxPhotoEdge, 1200, 800, 480]) {
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (cropSquare) context.drawImage(image, (image.width - width) / 2, (image.height - height) / 2,
        width, height, 0, 0, canvas.width, canvas.height);
      else context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const photo = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      if (photo?.type === "image/jpeg" && photo.size && photo.size <= maxPhotoBytes) {
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const match = typeof reader.result === "string" && /^data:image\/jpeg;base64,(.+)$/.exec(reader.result);
            if (match) resolve(match[1]!);
            else reject(new Error("Could not encode this photo."));
          };
          reader.onerror = () => reject(new Error("Could not read this photo."));
          reader.readAsDataURL(photo);
        });
      }
    }
    throw new Error("Could not prepare this photo.");
  } finally {
    image.close();
    canvas.width = canvas.height = 0;
  }
}
