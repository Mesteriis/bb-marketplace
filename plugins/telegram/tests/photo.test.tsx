// @vitest-environment jsdom
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { readTelegramPhoto } from "../src/adapters/bb/photo.ts";
import { maxPhotoBytes } from "../src/core/contract.ts";
import { PhotoPreview } from "../src/ui/photo-preview.tsx";

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
  const renderMessage = (id: string) => <MessageContent chatId="42" loadMedia={loadMedia}
    loadVideoStream={loadVideoStream} saveDocument={saveDocument} message={{ ...message, id }} />;
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
  rerender(renderMessage("13"));
  expect(document.querySelector(".mtg-media-player")).toBeNull();
});

test("navigates an album by arrow without downloading a concealed photo", async () => {
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
  fireEvent.click(trigger);
  expect(screen.getByText("1 / 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(screen.getByRole("button", { name: "Reset photo zoom" }).textContent).toBe("150%");
  fireEvent.keyDown(viewer, { key: "ArrowRight" });
  expect(screen.getByText("2 / 2")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Enlarged Telegram photo" })).toBeNull();
  expect(load).toHaveBeenCalledExactlyOnceWith("42", "123");
  expect(screen.queryByRole("button", { name: "Save photo" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show photo spoiler" }));
  await screen.findByRole("img", { name: "Enlarged Telegram photo" });
  expect(load.mock.calls).toEqual([["42", "123"], ["42", "124"], ["42", "124", "large"]]);
  fireEvent.click(screen.getByRole("button", { name: "Save photo" }));
  expect(save).toHaveBeenCalledExactlyOnceWith("42", "124");
  await screen.findByRole("button", { name: "Save photo" });
  fireEvent.click(screen.getByRole("button", { name: "Previous photo" }));
  expect(screen.getByText("1 / 2")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Enlarged Telegram photo" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reset photo zoom" }).textContent).toBe("Fit");
});
