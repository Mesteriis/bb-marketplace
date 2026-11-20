import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { displayedPhotoCrop, drawDraftPhoto, encodeDraftPhoto, preparedPhotoBlob, rotatePhotoCrop, type DraftPhotoEdits, type PhotoCrop } from "./prepare-photo.ts";
import { rotatePhotoPoint, type PhotoPoint, type PhotoStroke, type PhotoTool } from "./photo-drawing.ts";

type PhotoCaption = NonNullable<DraftPhotoEdits["caption"]>;
const initialCaption: PhotoCaption = { text: "", color: "#ffffff", font: "system-ui", size: 7, align: "center", position: "bottom" };
const cropEdges = [["left", "Left edge"], ["top", "Top edge"], ["right", "Right edge"], ["bottom", "Bottom edge"]] as const;
type PhotoDrag = { kind: "crop"; pointer: number; start: PhotoPoint }
  | { kind: "draw"; pointer: number; crop: PhotoCrop; turns: number; stroke: PhotoStroke };
const maxStrokes = 128;
const fitPhoto = { scale: 1, x: 0, y: 0 };

function photoViewport(scale: number, x: number, y: number) {
  const limit = (scale - 1) / 2;
  const clamp = (value: number) => Math.max(-limit, Math.min(limit, value));
  return { scale, x: clamp(x), y: clamp(y) };
}

function photoPoint(event: PointerEvent<HTMLCanvasElement>): PhotoPoint {
  const bounds = event.currentTarget.getBoundingClientRect();
  const percent = (point: number, start: number, size: number) => size > 0
    ? Math.max(0, Math.min(100, (point - start) / size * 100)) : 0;
  return { x: percent(event.clientX, bounds.left, bounds.width), y: percent(event.clientY, bounds.top, bounds.height) };
}

function cropBetween(a: PhotoPoint, b: PhotoPoint): PhotoCrop {
  return { left: Math.round(Math.min(a.x, b.x)), top: Math.round(Math.min(a.y, b.y)),
    right: Math.round(Math.max(a.x, b.x)), bottom: Math.round(Math.max(a.y, b.y)) };
}

function drawPoint({ x, y }: PhotoPoint, crop: PhotoCrop, turns: number) {
  return rotatePhotoPoint({ x: crop.left + x / 100 * (crop.right - crop.left),
    y: crop.top + y / 100 * (crop.bottom - crop.top) }, (4 - turns) % 4);
}

function extendStroke(stroke: PhotoStroke, point: PhotoPoint): PhotoStroke {
  const last = stroke.points.at(-1)!;
  if (Math.hypot(last.x - point.x, last.y - point.y) < 0.1) return stroke;
  const points = stroke.tool === "arrow" ? [stroke.points[0]!, point]
    : [...(stroke.points.length < 1024 ? stroke.points : stroke.points.slice(0, -1)), point];
  return { ...stroke, points };
}

export function EditDraftPhoto({ source, disabled, label, apply }: {
  source: File | string; disabled?: boolean; label?: string; apply: (base64: string) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="mtg-action" aria-label={label} disabled={disabled} onClick={() => setOpen(true)}>{tr("Edit photo")}</button>
    {open && <PhotoEditor source={source} close={() => setOpen(false)} apply={(data) => { apply(data); setOpen(false); }} />}
  </>;
}

export function PhotoEditor({ source, close, apply, initialMode }: {
  source: Blob | string; close: () => void; apply: (data: string) => void | Promise<void>; initialMode?: "draw";
}) {
  const { t: tr } = useTelegramLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const working = useRef(false);
  const pan = useRef<{ pointer: number; x: number; y: number } | undefined>(undefined);
  const [panning, setPanning] = useState(false);
  const [viewport, setViewport] = useState(fitPhoto);
  const [image, setImage] = useState<ImageBitmap>();
  const [turns, setTurns] = useState(0);
  const [crop, setCrop] = useState(false);
  const [customCrop, setCustomCrop] = useState<PhotoCrop>();
  const [mode, setMode] = useState<"crop" | "draw" | undefined>(initialMode);
  const [dragArea, setDragArea] = useState<PhotoCrop>();
  const drag = useRef<PhotoDrag | undefined>(undefined);
  const [tool, setTool] = useState<PhotoTool>("brush");
  const [inkColor, setInkColor] = useState("#ef4444");
  const [inkSize, setInkSize] = useState(3);
  const [drawing, setDrawing] = useState<{ strokes: PhotoStroke[]; undone: PhotoStroke[] }>({ strokes: [], undone: [] });
  const [strokePreview, setStrokePreview] = useState<PhotoStroke>();
  const [caption, setCaption] = useState(initialCaption);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [previewReady, setPreviewReady] = useState(false);
  const edits = { turns, crop: customCrop ?? crop, caption, strokes: drawing.strokes };
  const selectingCrop = mode === "crop";
  const drawingOnPhoto = mode === "draw";
  const changed = turns !== 0 || crop || !!customCrop || !!caption.text.trim() || drawing.strokes.length > 0;
  const rotatedWidth = image ? (turns % 2 ? image.height : image.width) : 0;
  const rotatedHeight = image ? (turns % 2 ? image.width : image.height) : 0;
  const square = Math.min(rotatedWidth, rotatedHeight);
  const squareX = crop && square > 0 ? Math.min(49, Math.round((1 - square / rotatedWidth) * 50)) : 0;
  const squareY = crop && square > 0 ? Math.min(49, Math.round((1 - square / rotatedHeight) * 50)) : 0;
  const area = customCrop ?? { left: squareX, top: squareY, right: 100 - squareX, bottom: 100 - squareY };
  const outline = dragArea ?? area;

  function zoomBy(factor: number, x = 0, y = 0) {
    setViewport((view) => {
      const scale = Math.max(1, Math.min(4, view.scale * factor));
      if (scale === view.scale) return view;
      const ratio = scale / view.scale;
      return photoViewport(scale, x + (view.x - x) * ratio, y + (view.y - y) * ratio);
    });
  }

  function shiftPhoto(x: number, y: number) {
    setViewport((view) => photoViewport(view.scale, view.x + x, view.y + y));
  }

  function startPan(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 1 || drag.current || pan.current) return;
    event.preventDefault();
    if (viewport.scale === 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
    setPanning(true);
  }

  function movePan(event: PointerEvent<HTMLDivElement>) {
    const previous = pan.current;
    if (!previous || previous.pointer !== event.pointerId) return;
    const { width, height } = event.currentTarget.getBoundingClientRect();
    if (width && height) shiftPhoto((event.clientX - previous.x) / width, (event.clientY - previous.y) / height);
    pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function stopPan(event: PointerEvent<HTMLDivElement>) {
    if (pan.current?.pointer !== event.pointerId) return;
    pan.current = undefined;
    setPanning(false);
  }

  function rotate(amount: 1 | 3) {
    setTurns((value) => (value + amount) % 4);
    setCustomCrop((value) => value && rotatePhotoCrop(value, amount));
  }

  function applyCrop(value: PhotoCrop) {
    setCrop(false);
    setCustomCrop(value.right - value.left < 100 || value.bottom - value.top < 100 ? value : undefined);
  }

  function startDrag(event: PointerEvent<HTMLCanvasElement>) {
    if (!image || !mode || busy || event.button !== 0 || !event.isPrimary || drag.current || pan.current) return;
    if (drawingOnPhoto && drawing.strokes.length >= maxStrokes) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = photoPoint(event);
    if (selectingCrop) {
      drag.current = { kind: "crop", pointer: event.pointerId, start: point };
      setDragArea(cropBetween(point, point));
    } else {
      const bounds = displayedPhotoCrop(image, turns, edits.crop);
      const stroke = { tool, color: inkColor, size: inkSize, points: [drawPoint(point, bounds, turns)] };
      drag.current = { kind: "draw", pointer: event.pointerId, crop: bounds, turns, stroke };
      setStrokePreview(stroke);
    }
  }

  function moveDrag(event: PointerEvent<HTMLCanvasElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const point = photoPoint(event);
    if (current.kind === "crop") setDragArea(cropBetween(current.start, point));
    else {
      current.stroke = extendStroke(current.stroke, drawPoint(point, current.crop, current.turns));
      setStrokePreview(current.stroke);
    }
  }

  function cancelDrag() {
    drag.current = undefined;
    setDragArea(undefined);
    setStrokePreview(undefined);
  }

  function finishDrag(event: PointerEvent<HTMLCanvasElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const point = photoPoint(event);
    cancelDrag();
    if (current.kind === "crop") {
      const next = cropBetween(current.start, point);
      if (next.right - next.left >= 2 && next.bottom - next.top >= 2) applyCrop(next);
    } else {
      const stroke = extendStroke(current.stroke, drawPoint(point, current.crop, current.turns));
      const tip = stroke.points.at(-1)!;
      const tail = stroke.points[0]!;
      if (stroke.tool !== "arrow" || Math.hypot(tip.x - tail.x, tip.y - tail.y) >= 0.1) {
        setDrawing(({ strokes }) => ({ strokes: [...strokes, stroke], undone: [] }));
      }
    }
  }

  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  useLayoutEffect(() => { setViewport(fitPhoto); }, [source, turns, crop, customCrop, selectingCrop]);
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    function wheel(event: WheelEvent) {
      if (!node || node.hidden || event.ctrlKey || event.metaKey || event.shiftKey
        || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      if (drag.current || pan.current || working.current) return;
      const { left, top, width, height } = node.getBoundingClientRect();
      if (!width || !height) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
      zoomBy(Math.exp(Math.max(-1, Math.min(1, -delta / 240))),
        (event.clientX - left) / width - 0.5, (event.clientY - top) / height - 0.5);
    }
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);
  useEffect(() => {
    let active = true;
    let decoded: ImageBitmap | undefined;
    setImage(undefined);
    setError("");
    async function load() {
      try {
        const file = typeof source === "string" ? preparedPhotoBlob(source) : source;
        decoded = await createImageBitmap(file);
        if (active) setImage(decoded);
        else decoded.close();
      } catch {
        if (active) setError("Could not open this photo for editing.");
      }
    }
    void load();
    return () => { active = false; decoded?.close(); };
  }, [source]);

  useLayoutEffect(() => {
    if (!image || !preview.current) { setPreviewReady(false); return; }
    try {
      const strokes = strokePreview ? [...drawing.strokes, strokePreview] : drawing.strokes;
      drawDraftPhoto(preview.current, image, 720, selectingCrop ? { turns, strokes } : { turns, crop: customCrop ?? crop, caption, strokes });
      setPreviewReady(true);
    } catch {
      setPreviewReady(false);
      setError("Could not draw the photo preview.");
    }
  }, [image, turns, crop, customCrop, selectingCrop, caption, drawing.strokes, strokePreview]);

  async function save() {
    if (!image || !previewReady || !changed || working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    const panel = dialog.current;
    try {
      const data = await encodeDraftPhoto(image, edits);
      if (panel?.isConnected && panel.open) await apply(data);
    } catch {
      if (panel?.isConnected && panel.open) setError("Could not apply the photo edits.");
    } finally {
      working.current = false;
      if (panel?.isConnected && panel.open) setBusy(false);
    }
  }

  return <dialog className="mtg-draft-photo-editor" ref={dialog} aria-label={tr("Edit draft photo")}
    onKeyDown={(event) => event.stopPropagation()} onCancel={(event) => {
    event.preventDefault();
    if (!working.current) close();
  }}>
    <div ref={stage} className="mtg-photo-crop-stage" role="group" aria-label={tr("Photo preview viewport")}
      tabIndex={viewport.scale > 1 ? 0 : undefined} data-selecting={selectingCrop || undefined} data-drawing={drawingOnPhoto || undefined}
      data-panning={panning || undefined} hidden={!previewReady}
      onPointerDown={startPan} onPointerMove={movePan} onPointerUp={stopPan} onPointerCancel={stopPan} onLostPointerCapture={stopPan}
      onAuxClick={(event) => { if (event.button === 1) event.preventDefault(); }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || viewport.scale === 1 || drag.current || pan.current) return;
        const directions: Record<string, [number, number]> = { ArrowLeft: [0.1, 0], ArrowRight: [-0.1, 0], ArrowUp: [0, 0.1], ArrowDown: [0, -0.1] };
        const direction = directions[event.key];
        if (!Array.isArray(direction)) return;
        event.preventDefault();
        shiftPhoto(...direction);
      }}>
      <div className="mtg-photo-crop-content"
        style={{ transform: `translate(${viewport.x * 100}%, ${viewport.y * 100}%) scale(${viewport.scale})` }}>
        <canvas ref={preview} aria-label={selectingCrop ? tr("Photo crop preview") : tr("Edited photo preview")} role="img" hidden={!previewReady}
          onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={cancelDrag}
          onLostPointerCapture={(event) => { if (drag.current?.pointer === event.pointerId) cancelDrag(); }} />
        {selectingCrop && <div className="mtg-photo-crop-outline" aria-hidden="true"
          style={{ left: `${outline.left}%`, top: `${outline.top}%`, right: `${100 - outline.right}%`, bottom: `${100 - outline.bottom}%` }} />}
      </div>
    </div>
    {!image && !error && <p role="status">{tr("Opening photo…")}</p>}
    <fieldset disabled={!image || busy} aria-label={tr("Photo edits")}>
      <div className="mtg-photo-edit-tools" role="group" aria-label={tr("Photo preview zoom")}>
        <button type="button" className="mtg-action" aria-label={tr("Zoom out in editor")} disabled={viewport.scale === 1}
          onClick={() => zoomBy(1 / 1.5)}>−</button>
        <button type="button" className="mtg-action" aria-label={tr("Reset editor zoom")} disabled={viewport.scale === 1}
          onClick={() => setViewport(fitPhoto)}>{viewport.scale === 1 ? tr("Fit") : `${Math.round(viewport.scale * 100)}%`}</button>
        <button type="button" className="mtg-action" aria-label={tr("Zoom in in editor")} disabled={viewport.scale === 4}
          onClick={() => zoomBy(1.5)}>+</button>
      </div>
      <div className="mtg-photo-edit-tools">
        <button type="button" className="mtg-action" onClick={() => rotate(3)}>{tr("Rotate left")}</button>
        <button type="button" className="mtg-action" onClick={() => rotate(1)}>{tr("Rotate right")}</button>
        <label><input type="checkbox" checked={crop} onChange={(event) => {
          setCrop(event.target.checked);
          setCustomCrop(undefined);
          if (selectingCrop) setMode(undefined);
        }} />{tr(" Square crop")}</label>
        <button type="button" className="mtg-action" onClick={() => setMode(selectingCrop ? undefined : "crop")}>
          {selectingCrop ? tr("Preview crop") : tr("Select crop")}
        </button>
        {customCrop && <button type="button" className="mtg-action" onClick={() => setCustomCrop(undefined)}>{tr("Clear crop")}</button>}
        <button type="button" className="mtg-action" aria-expanded={drawingOnPhoto} onClick={() => setMode(drawingOnPhoto ? undefined : "draw")}>
          {drawingOnPhoto ? tr("Finish drawing") : tr("Draw on photo")}
        </button>
      </div>
      {drawingOnPhoto && <div className="mtg-photo-edit-tools" role="group" aria-label={tr("Drawing tools")}>
        <label>{tr("Tool ")}<select value={tool} onChange={(event) => setTool(event.target.value as PhotoTool)}>
          <option value="brush">{tr("Brush")}</option><option value="marker">{tr("Marker")}</option>
          <option value="arrow">{tr("Arrow")}</option><option value="eraser">{tr("Eraser")}</option>
        </select></label>
        {tool !== "eraser" && <label>{tr("Stroke color ")}<input type="color" value={inkColor} onChange={(event) => setInkColor(event.target.value)} /></label>}
        <label>{tr("Stroke size ")}<input type="range" min="1" max="14" value={inkSize} onChange={(event) => setInkSize(event.target.valueAsNumber)} /></label>
        <button type="button" className="mtg-action" disabled={!drawing.strokes.length}
          onClick={() => setDrawing(({ strokes, undone }) => ({ strokes: strokes.slice(0, -1), undone: [...undone, strokes.at(-1)!] }))}>{tr("Undo stroke")}</button>
        <button type="button" className="mtg-action" disabled={!drawing.undone.length}
          onClick={() => setDrawing(({ strokes, undone }) => ({ strokes: [...strokes, undone.at(-1)!], undone: undone.slice(0, -1) }))}>{tr("Redo stroke")}</button>
        {drawing.strokes.length >= maxStrokes && <p role="status">{tr("Drawing limit reached. Undo a stroke to continue.")}</p>}
      </div>}
      {selectingCrop && <div className="mtg-photo-crop-controls">
        <p>{tr("Drag over the photo to select an area, or adjust its edges.")}</p>
        <div className="mtg-photo-edit-tools" role="group" aria-label={tr("Crop edges")}>
          {cropEdges.map(([edge, name]) => <label key={edge}>{name}
            <input type="range" min={edge === "right" ? area.left + 2 : edge === "bottom" ? area.top + 2 : 0}
              max={edge === "left" ? area.right - 2 : edge === "top" ? area.bottom - 2 : 100}
              value={area[edge]} aria-valuetext={`${area[edge]}%`}
              onChange={(event) => applyCrop({ ...area, [edge]: Number(event.target.value) })} />
          </label>)}
        </div>
      </div>}
      <label>{tr("Text on photo")}<textarea rows={2} maxLength={120} value={caption.text}
        onChange={(event) => setCaption({ ...caption, text: event.target.value.split("\n").slice(0, 3).join("\n") })} /></label>
      {caption.text.trim() && <div className="mtg-photo-edit-tools">
        <label>{tr("Color ")}<input type="color" value={caption.color} onChange={(event) => setCaption({ ...caption, color: event.target.value })} /></label>
        <label>{tr("Font ")}<select value={caption.font} onChange={(event) => setCaption({ ...caption, font: event.target.value })}>
          <option value="system-ui">{tr("Sans-serif")}</option><option value="serif">{tr("Serif")}</option><option value="monospace">{tr("Monospace")}</option>
        </select></label>
        <label>{tr("Size ")}<input type="range" min="3" max="18" value={caption.size} onChange={(event) => setCaption({ ...caption, size: event.target.valueAsNumber })} /></label>
        <label>{tr("Alignment ")}<select value={caption.align} onChange={(event) => setCaption({ ...caption, align: event.target.value as PhotoCaption["align"] })}>
          <option value="left">{tr("Left")}</option><option value="center">{tr("Center")}</option><option value="right">{tr("Right")}</option>
        </select></label>
        <label>{tr("Position ")}<select value={caption.position} onChange={(event) => setCaption({ ...caption, position: event.target.value as PhotoCaption["position"] })}>
          <option value="top">{tr("Top")}</option><option value="middle">{tr("Middle")}</option><option value="bottom">{tr("Bottom")}</option>
        </select></label>
      </div>}
    </fieldset>
    {error && <p role="alert">{tr(error)}</p>}
    <div className="mtg-photo-edit-tools">
      <button type="button" className="mtg-action" disabled={busy} onClick={close}>{tr("Cancel photo edits")}</button>
      <button type="button" className="mtg-action" disabled={!previewReady || !changed || busy} onClick={() => void save()}>{tr("Apply photo edits")}</button>
    </div>
  </dialog>;
}
