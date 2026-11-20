import type { PhotoCrop } from "./prepare-photo.ts";

export type PhotoPoint = { x: number; y: number };
export type PhotoTool = "brush" | "marker" | "eraser" | "arrow";
export type PhotoStroke = { tool: PhotoTool; color: string; size: number; points: readonly PhotoPoint[] };

export function rotatePhotoPoint({ x, y }: PhotoPoint, turns: number): PhotoPoint {
  switch (turns) {
    case 1: return { x: 100 - y, y: x };
    case 2: return { x: 100 - x, y: 100 - y };
    case 3: return { x: y, y: 100 - x };
    default: return { x, y };
  }
}

export function drawPhotoStrokes(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D,
  strokes: readonly PhotoStroke[], turns: number, crop: PhotoCrop) {
  const layer = document.createElement("canvas");
  layer.width = canvas.width;
  layer.height = canvas.height;
  try {
    const ink = layer.getContext("2d");
    if (!ink) throw new Error("Cannot draw on this photo.");
    const xScale = canvas.width / (crop.right - crop.left);
    const yScale = canvas.height / (crop.bottom - crop.top);
    const shortSide = Math.min(xScale, yScale);
    ink.lineCap = ink.lineJoin = "round";
    for (const stroke of strokes) {
      const points = stroke.points.map((point) => {
        const { x, y } = rotatePhotoPoint(point, turns);
        return { x: (x - crop.left) * xScale, y: (y - crop.top) * yScale };
      });
      const first = points[0];
      const last = points.at(-1);
      if (!first || !last) continue;
      const width = Math.max(1, shortSide * stroke.size);
      ink.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
      ink.globalAlpha = stroke.tool === "marker" ? 0.38 : 1;
      ink.strokeStyle = ink.fillStyle = stroke.color;
      ink.lineWidth = width;
      ink.beginPath();
      if (stroke.tool === "arrow") {
        const length = Math.hypot(last.x - first.x, last.y - first.y);
        if (!length) continue;
        const angle = Math.atan2(last.y - first.y, last.x - first.x);
        const head = Math.min(length * 0.45, Math.max(10, width * 4));
        ink.moveTo(first.x, first.y);
        ink.lineTo(last.x, last.y);
        for (const leg of [angle - Math.PI / 6, angle + Math.PI / 6]) {
          ink.moveTo(last.x, last.y);
          ink.lineTo(last.x - head * Math.cos(leg), last.y - head * Math.sin(leg));
        }
        ink.stroke();
      } else if (points.length === 1) {
        ink.arc(first.x, first.y, width / 2, 0, 2 * Math.PI);
        ink.fill();
      } else {
        ink.moveTo(first.x, first.y);
        for (const point of points.slice(1)) ink.lineTo(point.x, point.y);
        ink.stroke();
      }
    }
    context.drawImage(layer, 0, 0);
  } finally {
    layer.width = layer.height = 0;
  }
}
