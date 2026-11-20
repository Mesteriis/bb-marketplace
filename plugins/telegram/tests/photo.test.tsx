// @vitest-environment jsdom
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { readTelegramPhoto } from "../src/adapters/bb/photo.ts";
import { maxPhotoBytes } from "../src/core/contract.ts";
import { PhotoPreview } from "../src/ui/photo-preview.tsx";
import { PhotoTextRecognition } from "../src/ui/photo-text.tsx";
import { PreparePhotoFileDrag } from "../src/ui/photo-file-drag.tsx";

const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9sAAAAASUVORK5CYII=";
afterEach(cleanup);

test("reads only supported bounded image files in the owning TDLib directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "makosh-photo-"));
  const session = join(root, "session");
  try {
    await mkdir(session);
    const image = join(session, "photo");
    const outside = join(root, "outside");
    const alias = join(session, "alias");
    await writeFile(image, Buffer.from(base64, "base64"));
    await writeFile(outside, Buffer.from(base64, "base64"));
    await symlink(outside, alias);
    expect(await readTelegramPhoto(session, image)).toEqual({ mime: "image/png", base64 });
    await expect(readTelegramPhoto(session, alias)).rejects.toThrow("outside");
    await writeFile(image, "<svg><script/></svg>");
    await expect(readTelegramPhoto(session, image)).rejects.toThrow("Unsupported");
    await writeFile(image, Buffer.alloc(maxPhotoBytes + 1));
    await expect(readTelegramPhoto(session, image)).rejects.toThrow("size");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opens a photo only after an explicit click and scopes the lookup to its message", async () => {
  const load = vi.fn(async () => ({ mime: "image/png" as const, base64 }));
  render(<PhotoPreview chatId="42" messageId="123" load={load} />);
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show photo" }));
  expect(load).toHaveBeenCalledExactlyOnceWith("42", "123");
  expect((await screen.findByRole("img", { name: "Telegram photo" })).getAttribute("src"))
    .toBe(`data:image/png;base64,${base64}`);
});

test("auto-loads once only after the photo enters the visible area", async () => {
  let visibility!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  class Observer {
    constructor(callback: IntersectionObserverCallback) { visibility = callback; }
    observe() {}
    disconnect() { disconnect(); }
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  try {
    const load = vi.fn(async () => ({ mime: "image/png" as const, base64 }));
    const view = render(<PhotoPreview chatId="42" messageId="123" load={load} dimensions={{ width: 640, height: 480 }} />);
    expect(screen.queryByRole("button", { name: "Show photo" })).toBeNull();
    const placeholder = view.container.querySelector<HTMLElement>(".mtg-photo-placeholder");
    expect(placeholder?.style.aspectRatio).toBe("640 / 480");
    visibility([{ isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(load).not.toHaveBeenCalled();
    visibility([{ isIntersecting: true, intersectionRatio: 0.5 } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(load).toHaveBeenCalledExactlyOnceWith("42", "123");
    await screen.findByRole("img", { name: "Telegram photo" });
    const frame = screen.getByRole("button", { name: "Enlarge Telegram photo" });
    expect(frame.style.aspectRatio).toBe(placeholder?.style.aspectRatio);
    expect(frame.style.width).toBe(placeholder?.style.width);
    expect(disconnect).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("loads a pinned context photo only when visible and renders its caption", async () => {
  const { ConversationSearch } = await import("../src/ui/conversation-search.tsx");
  let visibility: IntersectionObserverCallback | undefined;
  class Observer {
    constructor(callback: IntersectionObserverCallback) { visibility = callback; }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  try {
    const loadPhoto = vi.fn(async () => ({ mime: "image/png" as const, base64 }));
    render(<ConversationSearch chatId="-42" initialMessage="123" close={() => {}}
      loadContext={async () => [{ id: "123", author: "Fixture", time: "", text: "Photo",
        hasPhoto: true, photoCaption: "Caption fixture" }]} loadPhoto={loadPhoto} />);
    await screen.findByText("Caption fixture");
    await vi.waitFor(() => expect(visibility).toBeTypeOf("function"));
    expect(loadPhoto).not.toHaveBeenCalled();
    expect(screen.queryByText("Photo", { exact: true })).toBeNull();
    visibility?.([{ isIntersecting: true, intersectionRatio: 0.5 } as IntersectionObserverEntry], {} as IntersectionObserver);
    await screen.findByRole("img", { name: "Telegram photo" });
    expect(loadPhoto).toHaveBeenCalledExactlyOnceWith("-42", "123");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("enlarges the loaded image in a dialog without downloading it again", async () => {
  const load = vi.fn(async () => ({ mime: "image/png" as const, base64 }));
  render(<PhotoPreview chatId="42" messageId="123" load={load} />);
  fireEvent.click(screen.getByRole("button", { name: "Show photo" }));
  const trigger = await screen.findByRole("button", { name: "Enlarge Telegram photo" });
  const viewer = document.querySelector("dialog")!;
  viewer.showModal = () => { viewer.open = true; };
  viewer.close = () => { viewer.open = false; fireEvent(viewer, new Event("close")); };
  fireEvent.click(trigger);
  const image = await screen.findByRole("img", { name: "Enlarged Telegram photo" });
  expect(image.getAttribute("src")).toBe(`data:image/png;base64,${base64}`);
  expect(screen.getByRole("dialog", { name: "Telegram photo viewer" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close photo" }));
  expect(screen.queryByRole("dialog", { name: "Telegram photo viewer" })).toBeNull();
  expect(load).toHaveBeenCalledOnce();
});

test("downloads a visible document only on click and keeps its caption", async () => {
  const { MessageContent } = await import("../src/ui/message-content.tsx");
  const saveDocument = vi.fn(async () => true);
  render(<MessageContent chatId="42" saveDocument={saveDocument} message={{
    id: "12", text: "File caption", author: "Fixture", time: "",
    document: { name: "Fixture.txt", downloadable: true, caption: "File caption", sizeBytes: 4 * 1024 ** 3 },
  }} />);
  expect(screen.getByText("File caption")).toBeTruthy();
  expect(screen.getByText("4 GiB")).toBeTruthy();
  expect(saveDocument).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Download Fixture.txt" }));
  await screen.findByRole("button", { name: "Download Fixture.txt" });
  expect(saveDocument).toHaveBeenCalledExactlyOnceWith("42", "12");
});

test("keeps the inline preview and loads the larger photo on opening the viewer", async () => {
  const load = vi.fn(async (_chatId: string, _messageId: string, size?: string) => size === "large"
    ? { mime: "image/jpeg" as const, base64: "/9j/" }
    : { mime: "image/png" as const, base64, hasLarger: true });
  render(<PhotoPreview chatId="42" messageId="123" load={load} />);
  fireEvent.click(screen.getByRole("button", { name: "Show photo" }));
  const trigger = await screen.findByRole("button", { name: "Enlarge Telegram photo" });
  expect(load).toHaveBeenCalledExactlyOnceWith("42", "123");
  const viewer = document.querySelector("dialog")!;
  viewer.showModal = () => { viewer.open = true; };
  fireEvent.click(trigger);
  await vi.waitFor(() => expect(screen.getByRole("img", { name: "Enlarged Telegram photo" }).getAttribute("src"))
    .toBe("data:image/jpeg;base64,/9j/"));
  expect(load).toHaveBeenNthCalledWith(2, "42", "123", "large");
  expect(screen.getByRole("img", { name: "Telegram photo" }).getAttribute("src")).toBe(`data:image/png;base64,${base64}`);
});

test("prepares a JPEG larger than the wire limit without changing its aspect ratio", async () => {
  const { preparePhoto } = await import("../src/ui/prepare-photo.ts");
  const close = vi.fn();
  const drawImage = vi.fn();
  const fillRect = vi.fn();
  const decode = vi.fn(async () => ({ width: 4000, height: 2000, close }));
  const input = new File([new Uint8Array(maxPhotoBytes + 1)], "fixture.jpg", { type: "image/jpeg" });
  vi.stubGlobal("createImageBitmap", decode);
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage, fillRect } as never);
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementationOnce((callback) => callback(new Blob([new Uint8Array(maxPhotoBytes + 1)], { type: "image/jpeg" })))
    .mockImplementationOnce((callback) => callback(new Blob([new Uint8Array([255, 216, 255])], { type: "image/jpeg" })));
  try {
    await expect(preparePhoto(input)).resolves.toBe("/9j/");
    expect(decode).toHaveBeenCalledExactlyOnceWith(input);
    expect(drawImage.mock.calls.map(([, , , width, height]) => [width, height]))
      .toEqual([[1600, 800], [1200, 600]]);
    expect(fillRect.mock.calls).toEqual([[0, 0, 1600, 800], [0, 0, 1200, 600]]);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    getContext.mockRestore();
    toBlob.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("projects photo marks through crop and rotation, and erases only the drawing layer", async () => {
  const { drawDraftPhoto } = await import("../src/ui/prepare-photo.ts");
  const canvas = document.createElement("canvas");
  const photo = { width: 200, height: 100 } as ImageBitmap;
  const main = { drawImage: vi.fn(), fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(), rotate: vi.fn(), translate: vi.fn() };
  const completed: [string, number][] = [];
  const ink = { globalCompositeOperation: "", globalAlpha: 0,
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    stroke() { completed.push([this.globalCompositeOperation, this.globalAlpha]); } };
  const contexts = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return (this === canvas ? main : ink) as never;
  });
  const points = [{ x: 70, y: 50 }, { x: 80, y: 50 }];
  try {
    drawDraftPhoto(canvas, photo, 720, { turns: 1, crop: { left: 25, top: 50, right: 75, bottom: 100 },
      strokes: ["brush", "marker", "eraser", "arrow"].map((tool) => ({
        tool: tool as import("../src/ui/photo-drawing.ts").PhotoTool, color: "#ff0000", size: 3, points,
      })) });
    expect([canvas.width, canvas.height]).toEqual([50, 100]);
    expect(ink.moveTo).toHaveBeenNthCalledWith(1, 25, 40);
    expect(ink.lineTo).toHaveBeenNthCalledWith(1, 25, 60);
    expect(ink.lineTo).toHaveBeenCalledTimes(6);
    expect(completed).toEqual([["source-over", 1], ["source-over", 0.38], ["destination-out", 1], ["source-over", 1]]);
    expect(main.drawImage).toHaveBeenNthCalledWith(1, photo, 100, 25, 100, 50, -50, -25, 100, 50);
    expect(main.drawImage).toHaveBeenNthCalledWith(2, expect.any(HTMLCanvasElement), 0, 0);
  } finally { contexts.mockRestore(); }
});

test("previews draft photo edits locally and applies only the confirmed result", async () => {
  const { EditDraftPhoto } = await import("../src/ui/edit-draft-photo.tsx");
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width: 240, height: 120, close }));
  const context = { drawImage: vi.fn(), fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
    translate: vi.fn(), rotate: vi.fn(), strokeText: vi.fn(), fillText: vi.fn() };
  vi.stubGlobal("createImageBitmap", decode);
  const modal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback) => callback(new Blob([new Uint8Array([255, 216, 255])], { type: "image/jpeg" })));
  const apply = vi.fn();
  try {
    const file = new File(["fixture"], "fixture.jpg", { type: "image/jpeg" });
    render(<EditDraftPhoto source={file} apply={apply} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit photo" }));
    const first = await screen.findByRole<HTMLCanvasElement>("img", { name: "Edited photo preview" });
    expect([first.width, first.height]).toEqual([240, 120]);
    const zoom = screen.getByRole("button", { name: "Zoom in in editor" });
    const resetZoom = screen.getByRole("button", { name: "Reset editor zoom" });
    const viewport = screen.getByRole("group", { name: "Photo preview viewport" });
    fireEvent.click(zoom);
    expect(resetZoom.textContent).toBe("150%");
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    expect(first.parentElement?.style.transform).toBe("translate(-10%, 0%) scale(1.5)");
    for (let step = 0; step < 6; step++) fireEvent.click(zoom);
    expect(resetZoom.textContent).toBe("400%");
    expect([first.width, first.height]).toEqual([240, 120]);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply photo edits" }).disabled).toBe(true);
    fireEvent.click(resetZoom);
    expect(resetZoom.textContent).toBe("Fit");
    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    expect([first.width, first.height]).toEqual([120, 240]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel photo edits" }));
    expect(apply).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit photo" }));
    const second = await screen.findByRole<HTMLCanvasElement>("img", { name: "Edited photo preview" });
    expect([second.width, second.height]).toEqual([240, 120]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Square crop" }));
    expect([second.width, second.height]).toEqual([120, 120]);
    fireEvent.click(screen.getByRole("button", { name: "Select crop" }));
    expect([second.width, second.height]).toEqual([240, 120]);
    expect(screen.getByRole<HTMLInputElement>("slider", { name: "Left edge" }).value).toBe("25");
    fireEvent.change(screen.getByRole("slider", { name: "Left edge" }), { target: { value: "50" } });
    fireEvent.change(screen.getByRole("slider", { name: "Bottom edge" }), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview crop" }));
    expect([second.width, second.height]).toEqual([60, 36]);
    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    expect([second.width, second.height]).toEqual([36, 60]);
    expect(context.drawImage).toHaveBeenLastCalledWith(expect.anything(), 120, 0, 60, 36, -30, -18, 60, 36);
    fireEvent.change(screen.getByRole("textbox", { name: "Text on photo" }), { target: { value: "Fixture" } });
    expect(context.fillText).toHaveBeenLastCalledWith("Fixture", 18, expect.any(Number), expect.any(Number));
    fireEvent.click(screen.getByRole("button", { name: "Apply photo edits" }));
    await vi.waitFor(() => expect(apply).toHaveBeenCalledExactlyOnceWith("/9j/"));
    expect(encode).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
  } finally {
    if (modal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", modal);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    getContext.mockRestore();
    encode.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("waits for photo spoiler disclosure and keeps the caption above it", async () => {
  const { MessageContent } = await import("../src/ui/message-content.tsx");
  const observe = vi.fn();
  class Observer {
    observe = observe;
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  try {
    const loadPhoto = vi.fn(async () => ({ mime: "image/png" as const, base64 }));
    const { container } = render(<MessageContent chatId="42" message={{ id: "12", author: "Fixture", time: "",
      text: "Caption fixture", hasPhoto: true, photoSpoiler: true, captionAboveMedia: true, photoCaption: "Caption fixture",
    }} loadPhoto={loadPhoto} />);
    expect(container.firstElementChild?.textContent).toBe("Caption fixture");
    expect(observe).not.toHaveBeenCalled();
    expect(loadPhoto).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show photo spoiler" }));
    await screen.findByRole("img", { name: "Telegram photo" });
    expect(loadPhoto).toHaveBeenCalledExactlyOnceWith("42", "12");
    expect(container.firstElementChild?.textContent).toBe("Caption fixture");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("shows the Telegram forward source above the attachment and its original caption", async () => {
  const { MessageContent } = await import("../src/ui/message-content.tsx");
  const { container } = render(<MessageContent chatId="42" message={{
    id: "12", text: "Caption fixture", author: "Sender fixture", time: "", forwardedFrom: "Source fixture",
    document: { name: "Fixture.pdf", downloadable: false, caption: "Caption fixture" },
  }} />);
  expect(container.firstElementChild?.textContent).toBe("Forwarded from Source fixture");
  expect(screen.getByText("Caption fixture")).toBeTruthy();
});

test.each([false, true])("keeps spoiler media and download controls hidden until disclosure (GIF: %s)", async (animation) => {
  const { MessageContent } = await import("../src/ui/message-content.tsx");
  const loadMedia = vi.fn(async () => new Blob());
  const loadVideoStream = vi.fn(async () => "/media/fixture");
  const saveDocument = vi.fn(async () => true);
  const message = { id: "12", text: "Fixture", author: "Fixture", time: "", animation: animation ? true as const : undefined, videoSpoiler: true as const,
    document: { name: "Fixture.mp4", downloadable: true, playbackMime: "video/mp4" as const, caption: "Fixture caption" } };
  const renderMessage = (id: string, editedAt?: number) => <MessageContent chatId="42" loadMedia={loadMedia}
    loadVideoStream={loadVideoStream} saveDocument={saveDocument} message={{ ...message, id, editedAt }} />;
  const { rerender } = render(renderMessage("12"));
  expect(screen.getByText("Fixture caption")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download Fixture.mp4" })).toBeNull();
  expect(document.querySelector(".mtg-media-player")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: animation ? "Show GIF spoiler" : "Show video spoiler" }));
  expect(screen.getByRole("button", { name: "Download Fixture.mp4" })).toBeTruthy();
  expect(document.querySelector(".mtg-media-player")).toBeTruthy();
  expect(loadMedia).not.toHaveBeenCalled();
  expect(loadVideoStream).not.toHaveBeenCalled();
  expect(saveDocument).not.toHaveBeenCalled();
  rerender(renderMessage("12", 1));
  expect(screen.queryByRole("button", { name: "Download Fixture.mp4" })).toBeNull();
  expect(document.querySelector(".mtg-media-player")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: animation ? "Show GIF spoiler" : "Show video spoiler" }));
  rerender(renderMessage("13", 1));
  expect(document.querySelector(".mtg-media-player")).toBeNull();
});

test("navigates an album and saves only the displayed eligible photo through the keyboard", async () => {
  const load = vi.fn(async (_chatId: string, id: string, size?: string) => ({
    mime: "image/png" as const, base64, hasLarger: id === "124" && size === undefined,
  }));
  const save = vi.fn(async () => true);
  render(<PhotoPreview chatId="42" messageId="123" load={load} save={save}
    album={[{ id: "123" }, { id: "124", spoiler: true, canSave: true }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Show photo" }));
  const trigger = await screen.findByRole("button", { name: "Enlarge Telegram photo" });
  const viewer = document.querySelector("dialog")!;
  viewer.showModal = () => { viewer.open = true; };
  expect(fireEvent.keyDown(viewer, { key: "s", metaKey: true })).toBe(true);
  fireEvent.click(trigger);
  expect(screen.getByText("1 / 2")).toBeTruthy();
  expect(fireEvent.keyDown(viewer, { key: "s", metaKey: true })).toBe(false);
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(screen.getByRole("button", { name: "Reset photo zoom" }).textContent).toBe("150%");
  fireEvent.keyDown(viewer, { key: "ArrowRight" });
  expect(screen.getByText("2 / 2")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Enlarged Telegram photo" })).toBeNull();
  expect(load).toHaveBeenCalledExactlyOnceWith("42", "123");
  expect(screen.queryByRole("button", { name: "Save photo" })).toBeNull();
  fireEvent.keyDown(viewer, { key: "s", ctrlKey: true });
  expect(save).not.toHaveBeenCalled();
  const reveal = screen.getByRole("button", { name: "Show photo spoiler" });
  reveal.focus();
  fireEvent.click(reveal);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close photo" }));
  await screen.findByRole("img", { name: "Enlarged Telegram photo" });
  expect(load.mock.calls).toEqual([["42", "123"], ["42", "124"], ["42", "124", "large"]]);
  const saveAction = screen.getByRole("button", { name: "Save photo" });
  expect(saveAction.getAttribute("aria-keyshortcuts")).toBe("Meta+S Control+S");
  fireEvent.keyDown(viewer, { key: "s", ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(viewer, { key: "s", metaKey: true, repeat: true });
  expect(save).not.toHaveBeenCalled();
  expect(fireEvent.keyDown(screen.getByRole("img", { name: "Enlarged Telegram photo" }),
    { key: "ы", code: "KeyS", metaKey: true })).toBe(false);
  fireEvent.keyDown(viewer, { key: "s", ctrlKey: true });
  fireEvent.click(saveAction);
  expect(save).toHaveBeenCalledExactlyOnceWith("42", "124");
  await screen.findByRole("button", { name: "Save photo" });
  fireEvent.click(screen.getByRole("button", { name: "Previous photo" }));
  expect(screen.getByText("1 / 2")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Enlarged Telegram photo" })).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Reset photo zoom" }).disabled).toBe(true);
});

test("prepares a single-file drag for the open exportable photo and drops it on album navigation", async () => {
  const load = vi.fn(async () => ({ mime: "image/png" as const, base64 }));
  const save = vi.fn(async () => true);
  const url = `/api/v1/plugins/makosh-telegram/http/document-download?ticket=${"x".repeat(43)}`;
  const prepare = vi.fn(async () => ({ name: "telegram-photo-123.jpg", url, validForMs: 60_000 }));
  render(<PreparePhotoFileDrag.Provider value={prepare}>
    <PhotoPreview chatId="42" messageId="123" load={load} save={save} canSave
      album={[{ id: "123", canSave: true }, { id: "124", spoiler: true, canSave: true }, { id: "125" }]} />
  </PreparePhotoFileDrag.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Show photo" }));
  const open = await screen.findByRole("button", { name: "Enlarge Telegram photo" });
  const viewer = document.querySelector("dialog")!;
  viewer.showModal = () => { viewer.open = true; };
  expect(open.querySelector("img")?.draggable).toBe(false);
  fireEvent.click(open);
  expect(prepare).not.toHaveBeenCalled();
  const control = screen.getByRole<HTMLButtonElement>("button", { name: "Prepare photo to drag" });
  expect(control.draggable).toBe(false);
  fireEvent.click(control);
  const target = await screen.findByRole<HTMLButtonElement>("button", { name: "Drag photo out" });
  expect(target.draggable).toBe(true);
  const transfer = { clearData: vi.fn(), setData: vi.fn(), effectAllowed: "none" };
  fireEvent.dragStart(target, { dataTransfer: transfer });
  expect(transfer.clearData).toHaveBeenCalledOnce();
  expect(transfer.effectAllowed).toBe("copy");
  expect(transfer.setData).toHaveBeenCalledExactlyOnceWith("DownloadURL",
    `image/jpeg:telegram-photo-123.jpg:${new URL(url, window.location.origin).href}`);
  expect(prepare).toHaveBeenCalledExactlyOnceWith("42", "123");
  expect(save).not.toHaveBeenCalled();
  fireEvent.dragEnd(target);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Prepare photo to drag" }).draggable).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
  expect(screen.getByRole("button", { name: "Show photo spoiler" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /photo to drag|drag photo out/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
  expect((await screen.findByRole<HTMLImageElement>("img", { name: "Enlarged Telegram photo" })).draggable).toBe(false);
  expect(screen.queryByRole("button", { name: /photo to drag|drag photo out/i })).toBeNull();
});

test("recognizes the visible photo and selects a line at its location", async () => {
  const load = vi.fn(async () => ({ mime: "image/png" as const, base64 }));
  const recognize = vi.fn(async () => ({ lines: [
    { text: "Synthetic line 🖼", x: .1, y: .2, width: .7, height: .1 },
    { text: "Target line", x: .1, y: .4, width: .4, height: .1 },
  ] }));
  const view = (canSave: boolean) => <PhotoTextRecognition.Provider value={recognize}>
    <PhotoPreview chatId="42" messageId="123" load={load} canSave={canSave} />
  </PhotoTextRecognition.Provider>;
  const { rerender } = render(view(true));
  fireEvent.click(screen.getByRole("button", { name: "Show photo" }));
  const trigger = await screen.findByRole("button", { name: "Enlarge Telegram photo" });
  const viewer = document.querySelector("dialog")!;
  viewer.showModal = () => { viewer.open = true; };
  expect(recognize).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  expect(recognize).not.toHaveBeenCalled();
  vi.stubGlobal("crypto", webcrypto);
  try {
    fireEvent.click(screen.getByRole("button", { name: "Recognize text" }));
    const text = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Recognized text" });
    expect(text.value).toBe("Synthetic line 🖼\nTarget line");
    expect(text.readOnly).toBe(true);
    expect(recognize).toHaveBeenCalledExactlyOnceWith("42", "123", "preview", expect.stringMatching(/^[a-f0-9]{64}$/));
    const region = screen.getByRole("button", { name: "Select text: Target line" });
    expect(region.style.top).toBe("40%");
    fireEvent.click(region);
    expect(document.activeElement).toBe(text);
    expect(text.value.slice(text.selectionStart, text.selectionEnd)).toBe("Target line");
    rerender(view(false));
    expect(screen.queryByRole("textbox", { name: "Recognized text" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Select text: Target line" })).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});

test("pinches and pans a photo, then swipes at fit size without opening a spoiler", async () => {
  const load = vi.fn(async () => ({ mime: "image/png" as const, base64 }));
  render(<PhotoPreview chatId="42" messageId="123" load={load}
    album={[{ id: "123" }, { id: "124", spoiler: true }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Show photo" }));
  const trigger = await screen.findByRole("button", { name: "Enlarge Telegram photo" });
  const viewer = document.querySelector("dialog")!;
  viewer.showModal = () => { viewer.open = true; };
  fireEvent.click(trigger);
  const image = screen.getByRole("img", { name: "Enlarged Telegram photo" });
  const panel = image.closest<HTMLElement>(".mtg-photo-zoom-viewport")!;
  const touch = (type: string, id: number, x: number, y = 40) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: "touch" } });
    fireEvent(panel, event);
  };
  const zoom = screen.getByRole("button", { name: "Reset photo zoom" });
  touch("pointerdown", 1, 40);
  touch("pointerdown", 2, 100);
  touch("pointermove", 2, 160);
  expect(zoom.textContent).toBe("200%");
  touch("pointerup", 2, 160);
  touch("pointerup", 1, 40);
  touch("pointerdown", 3, 150);
  touch("pointermove", 3, 60);
  touch("pointerup", 3, 60);
  expect(panel.scrollLeft).toBe(90);
  expect(screen.getByText("1 / 2")).toBeTruthy();

  fireEvent.click(zoom);
  expect(fireEvent.wheel(panel, { ctrlKey: true, deltaY: -100 })).toBe(false);
  expect(zoom.textContent).toBe("149%");
  fireEvent.click(zoom);
  touch("pointerdown", 4, 150);
  touch("pointercancel", 4, 50);
  expect(screen.getByText("1 / 2")).toBeTruthy();
  touch("pointerdown", 5, 150);
  touch("pointerup", 5, 50, 120);
  expect(screen.getByText("1 / 2")).toBeTruthy();
  touch("pointerdown", 6, 150);
  touch("pointerup", 6, 50);
  expect(screen.getByText("2 / 2")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show photo spoiler" })).toBeTruthy();
  expect(load).toHaveBeenCalledExactlyOnceWith("42", "123");
});

test("retries a failed gallery photo and falls back when the larger image cannot render", async () => {
  const preview = { mime: "image/png" as const, base64, hasLarger: true };
  const larger = { mime: "image/png" as const, base64: "invalid-larger-image" };
  let attempts = 0;
  const load = vi.fn(async (_chatId: string, id: string, size?: string) => {
    if (id === "10") return { ...preview, hasLarger: false };
    if (size === "large") return larger;
    if (attempts++ === 0) throw new Error("Fixture failure");
    return preview;
  });
  render(<PhotoPreview chatId="42" messageId="10" load={load} album={[{ id: "10" }, { id: "11" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Show photo" }));
  const trigger = await screen.findByRole("button", { name: "Enlarge Telegram photo" });
  const dialog = document.querySelector("dialog")!;
  dialog.showModal = () => { dialog.open = true; };
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
  const retry = await screen.findByRole("button", { name: "Retry photo" });
  fireEvent.click(retry);
  const image = await screen.findByRole("img", { name: "Enlarged Telegram photo" });
  await vi.waitFor(() => expect(image.getAttribute("src")).toContain(larger.base64));
  fireEvent.error(image);
  expect(image.getAttribute("src")).toContain(preview.base64);
  expect(screen.getByText("2 / 2")).toBeTruthy();
  expect(load.mock.calls).toEqual([["42", "10"], ["42", "11"], ["42", "11"], ["42", "11", "large"]]);
});

test("browses separate photo messages in one chat without loading a concealed neighbor", async () => {
  const { TelegramPage } = await import("../src/ui/telegram-page.tsx");
  const loadPhoto = vi.fn(async () => ({ mime: "image/png" as const, base64 }));
  const loadVideoStream = vi.fn(async () => "/fixture/photo-motion");
  const message = { author: "Fixture", time: "", text: "", hasPhoto: true };
  render(<TelegramPage live={{
    chats: [{ id: "42", name: "Photo fixture", initials: "FX", color: "#246dbd", subtitle: "Direct message", messages: [] }],
    folders: [], list: "main", selectList: vi.fn(), refresh: vi.fn(), loading: false, liveRevision: 0, error: "",
    findChats: async () => [], sendText: vi.fn(), loadPhoto, loadVideoStream,
    loadHistory: async () => ({ before: null, messages: [
      { ...message, id: "10", photoCaption: "First photo fixture" },
      { ...message, id: "11", photoCaption: "Second photo fixture", photoSpoiler: true, styles: [{ style: "bold", offset: 0, length: 6 }],
        photoMotion: { fileId: 34, mime: "video/mp4", sizeBytes: 42 } },
    ] }),
  }} />);
  fireEvent.click(screen.getByRole("button", { name: /Photo fixture/ }));
  const first = within((await screen.findByText("First photo fixture")).closest("li")!);
  fireEvent.click(first.getByRole("button", { name: "Show photo" }));
  const trigger = await first.findByRole("button", { name: "Enlarge Telegram photo" });
  const modal = trigger.parentElement!.querySelector("dialog")!;
  modal.showModal = () => { modal.open = true; };
  modal.close = () => { modal.open = false; };
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Telegram photo viewer" });
  const viewer = within(dialog);
  expect(viewer.getByText("1 / 2")).toBeTruthy();
  expect(viewer.getByText("First photo fixture")).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "ArrowRight", altKey: true });
  expect(viewer.getByText("1 / 2")).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  expect(viewer.getByText("2 / 2")).toBeTruthy();
  expect(viewer.queryByText("First photo fixture")).toBeNull();
  expect(viewer.queryByText("Second")).toBeNull();
  expect(loadPhoto).toHaveBeenCalledExactlyOnceWith("42", "10");
  expect(viewer.queryByRole("button", { name: "Load live photo video" })).toBeNull();
  expect(loadVideoStream).not.toHaveBeenCalled();
  fireEvent.click(viewer.getByRole("button", { name: "Show photo spoiler" }));
  await viewer.findByRole("img", { name: "Enlarged Telegram photo" });
  expect(loadPhoto).toHaveBeenLastCalledWith("42", "11");
  expect(viewer.getByText("Second").classList.contains("mtg-text-bold")).toBe(true);
  const motion = await viewer.findByRole("button", { name: "Load live photo video" });
  expect(loadVideoStream).not.toHaveBeenCalled();
  fireEvent.click(motion);
  const video = await viewer.findByLabelText("Telegram video");
  expect(loadVideoStream).toHaveBeenCalledExactlyOnceWith("42", "11", undefined, 34);
  fireEvent.keyDown(video, { key: "ArrowLeft" });
  expect(viewer.getByText("2 / 2")).toBeTruthy();
  fireEvent.click(viewer.getByRole("button", { name: "Previous photo" }));
  expect(viewer.queryByLabelText("Telegram video")).toBeNull();
  fireEvent.click(viewer.getByRole("button", { name: "Next photo" }));
  await viewer.findByRole("button", { name: "Load live photo video" });
  expect(loadVideoStream).toHaveBeenCalledTimes(1);
  const second = screen.getByRole("list", { name: "Messages" }).querySelector<HTMLElement>('[data-message-id="11"]')!;
  const scroll = vi.fn();
  second.scrollIntoView = scroll;
  fireEvent.click(viewer.getByRole("button", { name: "Go to photo message" }));
  expect(screen.queryByRole("dialog", { name: "Telegram photo viewer" })).toBeNull();
  expect(document.activeElement).toBe(second);
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "center" });
});
