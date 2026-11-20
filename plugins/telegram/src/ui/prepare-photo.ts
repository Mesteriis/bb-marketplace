import { maxPhotoBytes, maxPhotoEdge } from "../core/contract.ts";
import { drawPhotoStrokes, type PhotoStroke } from "./photo-drawing.ts";
export { maxOriginalPhotoBytes } from "../core/contract.ts";

const photoMimeTypes = ["image/jpeg", "image/png", "image/webp"];
export const photoAccept = photoMimeTypes.join(",");
export const isPhotoMimeType = (type: string) => photoMimeTypes.includes(type);
export function preparedPhotoBlob(base64: string, type = "image/jpeg") {
  return new Blob([Uint8Array.from(atob(base64), (unit) => unit.charCodeAt(0))], { type });
}

export type PhotoCrop = { left: number; top: number; right: number; bottom: number };

export function rotatePhotoCrop({ left, top, right, bottom }: PhotoCrop, turns: number): PhotoCrop {
  switch (turns) {
    case 1: return { left: 100 - bottom, top: left, right: 100 - top, bottom: right };
    case 2: return { left: 100 - right, top: 100 - bottom, right: 100 - left, bottom: 100 - top };
    case 3: return { left: top, top: 100 - right, right: bottom, bottom: 100 - left };
    default: return { left, top, right, bottom };
  }
}

export type DraftPhotoEdits = {
  crop?: boolean | PhotoCrop;
  turns?: number;
  strokes?: readonly PhotoStroke[];
  caption?: { text: string; color: string; font: string; size: number; align: "left" | "center" | "right"; position: "top" | "middle" | "bottom" };
};

export function displayedPhotoCrop(image: ImageBitmap, turns: number, crop: DraftPhotoEdits["crop"]): PhotoCrop {
  if (typeof crop === "object") return crop;
  const sideways = turns % 2 !== 0;
  const width = sideways ? image.height : image.width;
  const height = sideways ? image.width : image.height;
  const square = Math.min(width, height);
  const x = crop ? (1 - square / width) * 50 : 0;
  const y = crop ? (1 - square / height) * 50 : 0;
  return { left: x, top: y, right: 100 - x, bottom: 100 - y };
}

export function drawDraftPhoto(canvas: HTMLCanvasElement, image: ImageBitmap, maxEdge: number, { crop, turns = 0, caption, strokes }: DraftPhotoEdits = {}) {
  const context = canvas.getContext("2d");
  if (!context || !image.width || !image.height) throw new Error("Could not decode this photo.");
  const area = typeof crop === "object" ? rotatePhotoCrop(crop, (4 - turns) % 4) : undefined;
  const square = Math.min(image.width, image.height);
  const width = area ? image.width * (area.right - area.left) / 100 : crop ? square : image.width;
  const height = area ? image.height * (area.bottom - area.top) / 100 : crop ? square : image.height;
  if (width <= 0 || height <= 0) throw new Error("Invalid photo crop.");
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const sideways = turns % 2 !== 0;
  canvas.width = sideways ? h : w;
  canvas.height = sideways ? w : h;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (turns) {
    context.save();
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(turns * Math.PI / 2);
  }
  const x = turns ? -w / 2 : 0;
  const y = turns ? -h / 2 : 0;
  if (crop) {
    const sourceX = area ? image.width * area.left / 100 : (image.width - width) / 2;
    const sourceY = area ? image.height * area.top / 100 : (image.height - height) / 2;
    context.drawImage(image, sourceX, sourceY, width, height, x, y, w, h);
  }
  else context.drawImage(image, x, y, w, h);
  if (turns) context.restore();
  if (strokes?.length) drawPhotoStrokes(canvas, context, strokes, turns, displayedPhotoCrop(image, turns, crop));
  if (!caption?.text.trim()) return;
  const lines = caption.text.split(/\r?\n/).slice(0, 3);
  const size = Math.max(1, Math.min(canvas.width, canvas.height) * caption.size / 100);
  const margin = Math.min(canvas.width / 10, size);
  const step = size * 1.2;
  const blockHeight = step * lines.length;
  const top = caption.position === "top" ? margin : caption.position === "middle" ? (canvas.height - blockHeight) / 2 : canvas.height - blockHeight - margin;
  const left = caption.align === "left" ? margin : caption.align === "right" ? canvas.width - margin : canvas.width / 2;
  context.font = `600 ${size}px ${caption.font}`;
  context.textAlign = caption.align;
  context.textBaseline = "top";
  context.strokeStyle = "#171717";
  context.lineJoin = "round";
  context.lineWidth = Math.max(1, size / 11);
  context.fillStyle = caption.color;
  for (const [index, line] of lines.entries()) {
    context.strokeText(line, left, top + index * step, canvas.width - margin * 2);
    context.fillText(line, left, top + index * step, canvas.width - margin * 2);
  }
}

export async function encodeDraftPhoto(image: ImageBitmap, edits: DraftPhotoEdits): Promise<string> {
  const canvas = document.createElement("canvas");
  try {
    for (const maxEdge of [maxPhotoEdge, 1200, 800, 480]) {
      drawDraftPhoto(canvas, image, maxEdge, edits);
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
    canvas.width = canvas.height = 0;
  }
}

export async function preparePhoto(file: File, crop = false): Promise<string> {
  const image = await createImageBitmap(file);
  try { return await encodeDraftPhoto(image, { crop }); }
  finally { image.close(); }
}
