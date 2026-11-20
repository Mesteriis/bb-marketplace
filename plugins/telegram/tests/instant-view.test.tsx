// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { findInstantViewDocument, findInstantViewMap, findInstantViewPhoto, findInstantViewPlayback, readInstantView } from "../src/adapters/bb/instant-view.ts";
import { maxInstantViewBlocks, schemas } from "../src/core/contract.ts";
import { InstantViewButton, InstantViewJoin, InstantViewLoader, InstantViewDocumentSaver, InstantViewMapLoader, InstantViewIconLoader, InstantViewPhotoLoader, InstantViewPlaybackLoader, MediaSlideshow } from "../src/ui/instant-view.tsx";
import { MessageContent } from "../src/ui/message-content.tsx";
import { LoadBotWidgetPreview } from "../src/ui/bot-widget-preview.tsx";

import { OpenTelegramMessageLink } from "../src/ui/telegram-message-link.tsx";

afterEach(cleanup);

const articleText = (text: string) => ({ "@type": "richTextPlain", text });
const articleParagraph = (text: string) => ({ "@type": "pageBlockParagraph", text: articleText(text) });
const articlePage = (blocks: unknown[]) => ({ "@type": "webPageInstantView", is_full: true, blocks });
const articleDocumentBlock = (id: number) => ({
  "@type": "pageBlockDocument", document: { "@type": "document", file_name: `fixture-${id}.txt`,
    document: { "@type": "file", id, size: 1024 } },
});

test("retains long quotes and nested lists, with matching attachment lookup", () => {
  const paragraphs = Array.from({ length: 25 }, (_, index) => articleParagraph(`Paragraph ${index + 1}`));
  const page = articlePage([
    { "@type": "pageBlockBlockQuote", page_blocks: paragraphs },
    { "@type": "pageBlockList", items: [{ "@type": "pageBlockListItem",
      page_blocks: [...paragraphs, { "@type": "pageBlockAnchor", name: "late-file" }, articleDocumentBlock(81)] }] },
  ]);
  const article = schemas.instantView.output.parse(readInstantView(page));
  const [quote, list] = article!.blocks;
  expect(article!.partial).toBe(false);
  expect(quote).toMatchObject({ kind: "quoteGroup", paragraphs: expect.arrayContaining([{ kind: "paragraph", text: "Paragraph 25" }]) });
  expect(list?.kind === "list" && list.items[0]?.blocks.at(-1)).toMatchObject({ kind: "document", fileId: 81, anchors: ["late-file"] });
  expect(findInstantViewDocument(page, 81)?.fileId).toBe(81);
});

test("displays contextual entities in a web article without exporting their action payloads", async () => {
  const url = "https://example.com/contextual-entities";
  const page = articlePage([{ "@type": "pageBlockParagraph", text: {
    "@type": "richTexts",
    texts: [
      { "@type": "richTextBankCardNumber", text: { "@type": "richTextBold", text: articleText("Fixture card") },
        bank_card_number: "0000000000000000" },
      articleText(" / "),
      { "@type": "richTextTonAddress", text: articleText("Fixture address"), address: "fixture-wallet-payload" },
      articleText(" / "),
      { "@type": "richTextBotCommand", text: articleText("Fixture command"), bot_command: "/fixture_payload" },
    ],
  } }]);
  const article = schemas.instantView.output.parse(readInstantView(page, url));
  expect(article).toEqual({
    rtl: false, partial: false,
    blocks: [{ kind: "paragraph", text: "Fixture card / Fixture address / Fixture command",
      styles: [{ offset: 0, length: 12, style: "bold" }] }],
  });
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}>
      <InstantViewButton url={url} />
    </InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByText("Fixture card")).closest(".mtg-text-bold")).toBeTruthy();
    expect(dialog.querySelector("article")?.textContent).toContain("Fixture card / Fixture address / Fixture command");
    expect(within(dialog).queryByRole("button", { name: /fixture (card|address|command)/i })).toBeNull();
    expect(within(dialog).queryByRole("link", { name: /fixture (card|address|command)/i })).toBeNull();
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("shares the article block budget between quotes, galleries, lists, and attachment lookup", () => {
  const documents = Array.from({ length: maxInstantViewBlocks }, (_, index) => articleDocumentBlock(index + 1));
  const quote = { "@type": "pageBlockBlockQuote", blocks: [articleParagraph("Quote")] };
  const list = { "@type": "pageBlockList", items: [{ "@type": "pageBlockListItem", blocks: [articleParagraph("List item")] }] };
  const page = articlePage([quote, list, { "@type": "pageBlockCollage", blocks: documents }, articleDocumentBlock(999)]);
  const article = schemas.instantView.output.parse(readInstantView(page));
  const last = article!.blocks.at(-1);
  const count = maxInstantViewBlocks - 5;
  expect(article!.partial).toBe(true);
  expect(last?.kind === "collage" && last.media.map((item) => item.kind === "document" && item.fileId))
    .toEqual(Array.from({ length: count }, (_, index) => index + 1));
  expect(findInstantViewDocument(page, count)?.fileId).toBe(count);
  expect(findInstantViewDocument(page, count + 1)).toBeUndefined();
  expect(findInstantViewDocument(page, 999)).toBeUndefined();
});

test("opens a late gallery anchor and loads only its selected preview", async () => {
  const url = "https://example.com/long-gallery";
  const point = { latitude: 5, longitude: 6, zoom: 13 };
  const page = articlePage([
    { "@type": "pageBlockParagraph", text: { "@type": "richTextReference", text: articleText("Go to gallery end"), anchor_name: "gallery-end" } },
    { "@type": "pageBlockSlideshow", blocks: [
      ...Array.from({ length: 24 }, (_, index) => articleDocumentBlock(index + 1)),
      { "@type": "pageBlockMap", zoom: 13, location: { "@type": "location", latitude: 5, longitude: 6 } },
      { "@type": "pageBlockAnchor", name: "gallery-end" },
    ] },
  ]);
  const article = schemas.instantView.output.parse(readInstantView(page, url));
  expect(article!.partial).toBe(false);
  expect(findInstantViewMap(page, point)).toEqual(point);
  const loadMap = vi.fn(async () => "AA==");
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}>
      <InstantViewMapLoader.Provider value={loadMap}><InstantViewButton url={url} /></InstantViewMapLoader.Provider>
    </InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    fireEvent.click(await screen.findByRole("link", { name: "Go to gallery end" }));
    expect(screen.getByText("25 / 25")).toBeTruthy();
    expect(loadMap).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show map preview" }));
    await waitFor(() => expect(loadMap).toHaveBeenCalledExactlyOnceWith(url, point));
    fireEvent.click(screen.getByRole("button", { name: "Back to previous section" }));
    expect(screen.getByText("1 / 25")).toBeTruthy();
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("keeps slideshow navigation usable when refreshed media has fewer slides", () => {
  const select = vi.fn();
  const renderSlide = (index: number) => `Slide ${index + 1}`;
  const { rerender } = render(<MediaSlideshow count={25} index={24} rtl={false} select={select} renderSlide={renderSlide} />);
  expect(screen.getByText("Slide 25")).toBeTruthy();
  rerender(<MediaSlideshow count={3} index={24} rtl={false} select={select} renderSlide={renderSlide} />);
  expect(screen.getByText("Slide 3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Previous slide" }));
  expect(select).toHaveBeenCalledExactlyOnceWith(1);
});

test("reviews and joins a channel without leaving the Instant View article", async () => {
  const url = "https://example.com/article";
  const target = "https://t.me/fixture_news";
  const expected = { id: "-42", name: "Resolved fixture channel", mode: "request" as const };
  const review = vi.fn(async () => expected);
  const join = vi.fn(async () => "requested" as const);
  const article = { rtl: false, partial: false, blocks: [{ kind: "chatLink" as const, url: target, text: "Article title for channel" }] };
  const modal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewJoin.Provider value={{ review, join }}>
      <InstantViewLoader.Provider value={async () => article}><InstantViewButton url={url} /></InstantViewLoader.Provider>
    </InstantViewJoin.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review join" }));
    await screen.findByText(expected.name);
    expect(review).toHaveBeenCalledExactlyOnceWith(url, target);
    expect(join).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel join" }));
    expect(join).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review join" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send join request" }));
    await screen.findByText("Join request sent.");
    expect(join).toHaveBeenCalledExactlyOnceWith(url, target, expected);
    expect(screen.getByRole("dialog", { name: "Instant View" })).toBeTruthy();
  } finally {
    if (modal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", modal);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  }
});

test("opens only the static text of a bot widget and retains its formatted caption", async () => {
  const load = vi.fn(async () => ({ html: `<p onclick="window.fixtureExecuted=true">Widget <strong>content</strong></p>
    <script>window.fixtureExecuted=true</script><img src="https://example.test/pixel">
    <a href="https://example.test/link">Plain link label</a><iframe src="https://example.test/frame"></iframe>
    <form><button>Send data</button></form><svg><text>Ignore SVG</text></svg>` }));
  const { container } = render(<LoadBotWidgetPreview.Provider value={load}><MessageContent chatId="42"
    message={{ id: "7", text: "Widget caption", author: "Bot", time: "", widget: true, captionAboveMedia: true,
      styles: [{ offset: 0, length: 6, style: "bold" }] }} /></LoadBotWidgetPreview.Provider>);
  const open = screen.getByRole("button", { name: "Show widget preview" });
  expect(screen.getByText("caption", { exact: false }).closest(".mtg-bot-widget")).toBeNull();
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(open);
  expect(await screen.findByText("content")).toHaveProperty("tagName", "STRONG");
  expect(screen.getByText("Plain link label").closest("a")).toBeNull();
  expect(container.querySelector("script, img, iframe, form, svg, [onclick]")).toBeNull();
  expect(screen.queryByText("Send data")).toBeNull();
  expect(load).toHaveBeenCalledExactlyOnceWith("42", "7");
  fireEvent.click(screen.getByRole("button", { name: "Hide widget preview" }));
  expect(screen.queryByText("content")).toBeNull();
});

test("shows Instant View revisions on demand without exposing removed links or spoilers", async () => {
  const url = "https://example.com/revisions";
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const spoiler = (text: string) => ({ "@type": "richTextSpoiler", text: plain(text) });
  const sequence = (...texts: unknown[]) => ({ "@type": "richTexts", texts });
  const diff = (old_text: unknown, text: unknown) => ({ "@type": "richTextDiff", old_text, text });
  const block = (text: unknown) => ({ "@type": "pageBlockParagraph", text });
  const deleted = block(diff(plain("Removed sentence"), plain("")));
  const page = (...blocks: unknown[]) => ({ "@type": "webPageInstantView", is_full: true, blocks });
  const article = schemas.instantView.output.parse(readInstantView(page(
    block(diff(
      sequence({ "@type": "richTextUrl", url: "https://example.com/removed", text: plain("Old link") }, spoiler("Old secret")),
      sequence({ "@type": "richTextUrl", url: "https://example.com/current", text: plain("Current link") }, spoiler("New secret")),
    )),
    block({ "@type": "richTextSpoiler", text: diff(plain("Hidden before"), plain("Hidden after")) }),
    { "@type": "pageBlockTable", cells: [[{
      "@type": "pageBlockTableCell", text: diff(plain(""), plain("New cell")),
    }]] },
    deleted,
  ), url));
  expect(article?.partial).toBe(false);
  expect(article?.changes).toEqual([
    { original: "Old link[Spoiler]", current: "Current link[Spoiler]" },
    { original: "", current: "New cell" },
    { original: "Removed sentence", current: "" },
  ]);
  expect(schemas.instantView.output.parse(readInstantView(page(deleted), url))).toMatchObject({
    blocks: [], changes: [{ original: "Removed sentence", current: "" }],
  });
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}><InstantViewButton url={url} /></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const toggle = await screen.findByRole("button", { name: "Show changes" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Removed sentence")).toBeNull();
    expect(screen.getByRole("link", { name: "Current link" }).getAttribute("href")).toBe("https://example.com/current");
    const dialog = screen.getByRole("dialog", { name: "Instant View" });
    dialog.scrollTop = 380;
    fireEvent.click(toggle);
    const comparison = screen.getByRole("region", { name: "Article changes" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.scrollTop).toBe(0);
    expect(document.activeElement).toBe(comparison);
    expect(within(comparison).getByText("Old link[Spoiler]").tagName).toBe("DEL");
    expect(within(comparison).getByText("New cell").tagName).toBe("INS");
    expect(within(comparison).getByText("Removed sentence").tagName).toBe("DEL");
    expect(comparison.textContent).not.toMatch(/secret|Hidden (before|after)/);
    expect(within(comparison).queryByRole("link")).toBeNull();
    expect(screen.queryByRole("link", { name: /Old link/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide changes" }));
    expect(screen.queryByRole("region", { name: "Article changes" })).toBeNull();
    expect(dialog.scrollTop).toBe(380);
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("scales only the current Instant View article and preserves its visible block", async () => {
  const url = "https://example.com/article";
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  const load = vi.fn(async () => ({ partial: false, rtl: false,
    blocks: [{ kind: "paragraph" as const, text: "Reading position" }] }));
  try {
    render(<InstantViewLoader.Provider value={load}><InstantViewButton url={url} /></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const block = await screen.findByText("Reading position");
    const article = screen.getByRole("article");
    const dialog = screen.getByRole<HTMLDialogElement>("dialog", { name: "Instant View" });
    const control = screen.getByRole<HTMLSelectElement>("combobox", { name: "Zoom" });
    const toolbar = control.closest(".mtg-instant-view-actions")!;
    vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 50));
    vi.spyOn(block, "getBoundingClientRect")
      .mockReturnValueOnce(new DOMRect(0, 25, 400, 100))
      .mockReturnValueOnce(new DOMRect(0, 25, 400, 100))
      .mockReturnValueOnce(new DOMRect(0, 55, 400, 200));
    dialog.scrollTop = 500;
    fireEvent.change(control, { target: { value: "150" } });
    expect(control.value).toBe("150");
    expect(article.style.zoom).toBe("1.5");
    expect(dialog.getAttribute("style")).toBeNull();
    expect(dialog.scrollTop).toBe(555);
    expect(fireEvent.keyDown(control, { key: "-", metaKey: true })).toBe(false);
    expect(control.value).toBe("125");
    expect(fireEvent.keyDown(control, { key: "0", ctrlKey: true })).toBe(false);
    expect(control.value).toBe("100");
    expect(load).toHaveBeenCalledExactlyOnceWith(url);
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("copies Instant View code only after every spoiler has been revealed", async () => {
  const url = "https://example.com/spoiler-code";
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const spoiler = (text: string) => ({ "@type": "richTextSpoiler", text: plain(text) });
  const code = "const value = first + second;";
  const article = schemas.instantView.output.parse(readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockPreformatted", language: "js", text: { "@type": "richTexts", texts: [
      plain("const value = "), spoiler("first"), plain(" + "), spoiler("second"), plain(";"),
    ] } },
    { "@type": "pageBlockTable", caption: { "@type": "richTexts", texts: [plain("Report "), spoiler("concealed caption")] },
      cells: [[{ "@type": "pageBlockTableCell", text: plain("Fixture cell") }]] },
  ] }, url));
  const clipboard = vi.fn(async (_text: string) => {});
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}><InstantViewButton url={url} /></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const copy = await screen.findByRole<HTMLButtonElement>("button", { name: "Copy code" });
    expect(copy.disabled).toBe(true);
    fireEvent.click(copy);
    expect(clipboard).not.toHaveBeenCalled();
    const block = copy.closest(".mtg-instant-view-code")!;
    fireEvent.click(within(block as HTMLElement).getAllByRole("button", { name: "Show spoiler" })[0]!);
    expect(copy.disabled).toBe(true);
    fireEvent.click(within(block as HTMLElement).getByRole("button", { name: "Show spoiler" }));
    expect(copy.disabled).toBe(false);
    fireEvent.click(copy);
    await waitFor(() => expect(clipboard).toHaveBeenCalledExactlyOnceWith(code));

    const table = screen.getByRole("region", { name: /Report/ });
    expect(screen.queryByRole("region", { name: /concealed caption/ })).toBeNull();
    fireEvent.click(within(table).getByRole("button", { name: "Show spoiler" }));
    expect(screen.getByRole("region", { name: "Report concealed caption" })).toBe(table);
  } finally {
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("loads article video posters on visibility and keeps spoiler posters hidden until revealed", async () => {
  const observers: IntersectionObserverCallback[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observers.push(callback); }
    observe() {}
    disconnect() {}
  });
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    const url = "https://example.com/video-posters";
    const video = (id: number, format: string, spoiler = false) => ({
      "@type": "pageBlockVideo", has_spoiler: spoiler, video: {
        mime_type: "video/mp4", width: id === 3 ? -1 : 1920, height: 1080, video: { id, size: 8192 }, thumbnail: {
          "@type": "thumbnail", format: { "@type": format }, file: { "@type": "file", id: id + 100, size: 120 },
        },
      },
    });
    const page = { "@type": "webPageInstantView", blocks: [video(1, "thumbnailFormatJpeg"), {
      "@type": "pageBlockSlideshow", blocks: [video(2, "thumbnailFormatWebp", true)],
    }, video(3, "thumbnailFormatMpeg4")] };
    const selectPhoto = () => undefined;
    const article = schemas.instantView.output.parse(readInstantView(page, url, selectPhoto));
    expect(article?.blocks).toMatchObject([
      { video: { posterFileId: 101, dimensions: { width: 1920, height: 1080 } } },
      { media: [{ video: { posterFileId: 102, dimensions: { width: 1920, height: 1080 } } }] },
      { video: { fileId: 3 } },
    ]);
    expect(article?.blocks[2]).not.toHaveProperty("video.dimensions");
    expect(findInstantViewPhoto(page, 101, selectPhoto)).toEqual({ preview: 101, large: 101 });
    expect(findInstantViewPhoto(page, 102, selectPhoto)).toEqual({ preview: 102, large: 102 });
    expect(findInstantViewPhoto(page, 103, selectPhoto)).toBeUndefined();
    expect(findInstantViewPhoto(page, 1, selectPhoto)).toBeUndefined();
    const photo = vi.fn(async () => ({ mime: "image/jpeg" as const, base64: "/9j/" }));
    const playback = vi.fn(async () => "/fixture/video");
    render(<InstantViewLoader.Provider value={async () => article}><InstantViewPhotoLoader.Provider value={photo}>
      <InstantViewPlaybackLoader.Provider value={playback}><InstantViewButton url={url} /></InstantViewPlaybackLoader.Provider>
    </InstantViewPhotoLoader.Provider></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const hidden = await screen.findByRole("button", { name: "Show video spoiler" });
    await waitFor(() => expect(observers).toHaveLength(1));
    expect(photo).not.toHaveBeenCalled();
    const show = (callback: IntersectionObserverCallback) => act(() =>
      callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    const button = screen.getAllByRole("button", { name: "Load video player" })[0]!;
    const slot = button.querySelector<HTMLElement>(".mtg-video-poster");
    expect(slot?.style.aspectRatio).toBe("1920 / 1080");
    expect(slot?.querySelector("img")).toBeNull();
    expect(hidden.querySelector(".mtg-video-poster")).toBeNull();
    show(observers[0]!);
    await waitFor(() => expect(slot?.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/"));
    expect(button.querySelector(".mtg-video-poster")).toBe(slot);
    expect(photo.mock.calls).toEqual([[url, 101]]);
    expect(playback).not.toHaveBeenCalled();
    fireEvent.click(hidden);
    await waitFor(() => expect(observers).toHaveLength(2));
    show(observers[1]!);
    await waitFor(() => expect(photo.mock.calls).toEqual([[url, 101], [url, 102]]));
    fireEvent.click(button);
    expect((await screen.findByLabelText("Telegram video")).getAttribute("poster")).toBe("data:image/jpeg;base64,/9j/");
    expect(playback.mock.calls).toEqual([[url, 1]]);
  } finally {
    vi.unstubAllGlobals();
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("retries an article stream without closing the article or losing its caption", async () => {
  const url = "https://example.com/article";
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [{
    "@type": "pageBlockVideo", video: { mime_type: "video/mp4", video: { id: 26, size: 8192 } },
    caption: { text: { "@type": "richTextPlain", text: "Retry fixture caption" } },
  }] });
  const playback = vi.fn().mockRejectedValueOnce(new Error("Stream unavailable")).mockResolvedValue("/fixture/retry");
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}><InstantViewPlaybackLoader.Provider value={playback}>
      <InstantViewButton url={url} />
    </InstantViewPlaybackLoader.Provider></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load video player" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not play this media.");
    expect(screen.getByText("Retry fixture caption")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    const player = await screen.findByLabelText("Telegram video");
    expect(player.getAttribute("src")).toBe("/fixture/retry");
    expect(playback.mock.calls).toEqual([[url, 26], [url, 26]]);
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("preserves inline article buttons and executes copy only after a click", async () => {
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const button = (label: string, type: object) => ({ "@type": "richTextButton",
    button: { "@type": "inlineButton", text: plain(label), type } });
  const article = schemas.instantView.output.parse(readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockParagraph", text: { "@type": "richTexts", texts: [plain("Before "),
      button("Open details", { "@type": "inlineKeyboardButtonTypeUrl", url: "https://example.com/details" }), plain(" and "),
      { "@type": "richTextUrl", url: "https://example.com/outer",
        text: button("Copy code", { "@type": "inlineKeyboardButtonTypeCopyText", text: "Synthetic code" }) }, plain(" after."),
    ] } },
  ] }));
  expect(article).toMatchObject({ partial: false, blocks: [{ text: "Before Open details and Copy code after.", inlineButtons: [
    { offset: 7, length: 12, button: { kind: "url", label: "Open details", url: "https://example.com/details" } },
    { offset: 24, length: 9, button: { kind: "copy", label: "Copy code", text: "Synthetic code" } },
  ] }] });
  const copy = vi.fn().mockResolvedValue(undefined);
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value(this: HTMLDialogElement) { this.open = true; },
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}><InstantViewButton url="https://example.com/article" /></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    expect((await screen.findByRole("link", { name: "Open details" })).getAttribute("href")).toBe("https://example.com/details");
    expect(copy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copy code" }).closest("a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith("Synthetic code"));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Copied.");
  } finally {
    if (showModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", showModal);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("keeps labels of unsafe or unsupported inline buttons without activating them", () => {
  const button = (url: string) => ({ "@type": "richTextButton", button: { "@type": "inlineButton",
    text: { "@type": "richTextPlain", text: "Visible label" }, type: { "@type": "inlineKeyboardButtonTypeUrl", url } } });
  const withAction = (type: object) => ({ ...button(""), button: { ...button("").button, type } });
  for (const node of [button("javascript:alert(1)"),
    withAction({ "@type": "inlineKeyboardButtonTypeCallback", data: "fixture" }),
    withAction({ "@type": "inlineKeyboardButtonTypeUser", user_id: 0 }),
    withAction({ "@type": "inlineKeyboardButtonTypeUser", user_id: Number.MAX_SAFE_INTEGER + 1 })]) {
    const result = readInstantView({ "@type": "webPageInstantView", is_full: true,
      blocks: [{ "@type": "pageBlockParagraph", text: node }] });
    expect(result).toMatchObject({ partial: true, blocks: [{ text: "Visible label" }] });
    expect(result?.blocks[0]).not.toHaveProperty("inlineButtons");
  }
});

test("retains disabled article buttons without exposing unsupported callback data", async () => {
  const button = (label: string, type: object) => ({ "@type": "inlineButton", text: articleText(label),
    style: { "@type": "buttonStylePrimary" }, type });
  const disabled = { "@type": "inlineKeyboardButtonTypeDisabled" };
  const article = schemas.instantView.output.parse(readInstantView(articlePage([
    { "@type": "pageBlockParagraph", text: { "@type": "richTextButton", button: button("Inline unavailable", disabled) } },
    { "@type": "pageBlockButtonRow", buttons: [
      button("Row unavailable", disabled),
      button("Server action", { "@type": "inlineKeyboardButtonTypeCallback", data: "private-fixture-payload" }),
      button("Read more", { "@type": "inlineKeyboardButtonTypeUrl", url: "https://example.com/details" }),
    ] },
  ])));
  expect(article?.partial).toBe(true);
  expect(JSON.stringify(article)).not.toContain("private-fixture-payload");
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}>
      <InstantViewButton url="https://example.com/article" />
    </InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    expect(await screen.findByRole("link", { name: "Read more" })).toBeTruthy();
    for (const name of ["Inline unavailable", "Row unavailable", "Server action"]) {
      expect(screen.getByRole("button", { name })).toHaveProperty("disabled", true);
    }
    expect(screen.getByRole("button", { name: "Row unavailable" }).dataset.buttonStyle).toBe("primary");
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("saves the current Instant View photo by button or shortcut without exporting a spoiler", async () => {
  const url = "https://example.com/gallery-save";
  const photo = (fileId: number, spoiler = false) => ({ fileId, dimensions: { width: 320, height: 240 }, spoiler });
  const article: NonNullable<ReturnType<typeof readInstantView>> = {
    rtl: false, partial: false, blocks: [
      { kind: "photo", text: "Standalone photo", photo: photo(40) },
      { kind: "collage", text: "Gallery", media: [
        { kind: "photo", text: "First entry", photo: photo(41) },
        { kind: "photo", text: "Second entry", photo: photo(42) },
        { kind: "photo", text: "Spoiler entry", photo: photo(43, true) },
      ] },
    ],
  };
  const save = vi.fn(async () => true);
  const load = async () => ({ mime: "image/png" as const, base64: "AA==" });
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  const close = Object.getOwnPropertyDescriptor(prototype, "close");
  Object.defineProperties(prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event("close")); } },
  });
  try {
    render(<InstantViewLoader.Provider value={async () => article}>
      <InstantViewPhotoLoader.Provider value={load}><InstantViewDocumentSaver.Provider value={save}>
        <InstantViewButton url={url} />
      </InstantViewDocumentSaver.Provider></InstantViewPhotoLoader.Provider>
    </InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const articleView = screen.getByRole("dialog", { name: "Instant View" });
    const openPhoto = async (element: HTMLElement) => {
      const scope = within(element);
      const show = scope.queryByRole("button", { name: "Show photo" });
      if (show) fireEvent.click(show);
      fireEvent.click(await scope.findByRole("button", { name: "Enlarge Telegram photo" }));
      return within(scope.getByRole("dialog", { name: "Telegram photo viewer" }));
    };
    const standalone = (await within(articleView).findByText("Standalone photo")).closest("figure")!;
    const single = await openPhoto(standalone);
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(single.getByRole("button", { name: "Save photo" }));
    await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith(url, 40));
    fireEvent.click(await single.findByRole("button", { name: "Close photo" }));

    const entry = within(articleView).getByText("First entry").closest("li")!;
    const viewer = await openPhoto(entry);
    fireEvent.click(viewer.getByRole("button", { name: "Next photo" }));
    const control = await viewer.findByRole("button", { name: "Save photo" });
    fireEvent.keyDown(control, { key: "s", metaKey: true });
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(url, 42));
    fireEvent.click(viewer.getByRole("button", { name: "Next photo" }));
    expect(viewer.queryByRole("button", { name: "Save photo" })).toBeNull();
    fireEvent.keyDown(viewer.getByRole("button", { name: "Close photo" }), { key: "s", ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(2);
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
    if (close) Object.defineProperty(prototype, "close", close);
    else Reflect.deleteProperty(prototype, "close");
  }
});

test("upgrades oversized visible article photos without refetching when the gallery opens", async () => {
  const intersections: IntersectionObserverCallback[] = [];
  const resizes: ResizeObserverCallback[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersections.push(callback); }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resizes.push(callback); }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("devicePixelRatio", 1);
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    const url = "https://example.com/responsive-photo";
    const photo = { "@type": "pageBlockPhoto", photo: { "@type": "photo", sizes: [] } };
    const article = schemas.instantView.output.parse(readInstantView(articlePage([photo, { ...photo, has_spoiler: true }]), url,
      () => ({ preview: 3, large: 4, dimensions: { width: 400, height: 300 }, largeDimensions: { width: 1200, height: 900 } })));
    expect(article?.blocks[0]).toMatchObject({ photo: { fileId: 4, fullWidth: 1200 } });
    const load = vi.fn(async (_url: string, _id: number, size?: string) => ({
      mime: "image/jpeg" as const, base64: size === "large" ? "/9j/AA==" : "/9j/", ...(size !== "large" && { hasLarger: true }),
    }));
    render(<InstantViewLoader.Provider value={async () => article}>
      <InstantViewPhotoLoader.Provider value={load}><InstantViewButton url={url} /></InstantViewPhotoLoader.Provider>
    </InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    await screen.findByRole("button", { name: "Show photo spoiler" });
    await waitFor(() => expect(intersections).toHaveLength(1));
    const show = (callback: IntersectionObserverCallback, visible: boolean) => act(() =>
      callback([{ isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(load).not.toHaveBeenCalled();
    show(intersections[0]!, true);
    const image = await screen.findByRole<HTMLImageElement>("img", { name: "Telegram photo" });
    let width = 320;
    vi.spyOn(image, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, 240));
    const opener = screen.getByRole("button", { name: "Enlarge Telegram photo" });
    expect(opener.style.width).toBe("1200px");
    await waitFor(() => expect(intersections).toHaveLength(2));
    show(intersections[1]!, true);
    expect(load).toHaveBeenCalledTimes(1);
    show(intersections[1]!, false);
    width = 600;
    act(() => resizes[0]!([], {} as ResizeObserver));
    expect(load).toHaveBeenCalledTimes(1);
    show(intersections[1]!, true);
    await waitFor(() => expect(image.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/AA=="));
    expect(screen.getByRole("button", { name: "Enlarge Telegram photo" })).toBe(opener);
    fireEvent.click(opener);
    const viewer = screen.getByRole("dialog", { name: "Telegram photo viewer" });
    expect(viewer.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/AA==");
    expect(load.mock.calls).toEqual([[url, 4, undefined], [url, 4, "large"]]);
  } finally {
    vi.unstubAllGlobals();
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test.each(["collage", "slideshow"] as const)("navigates repeated photos as distinct entries in an article %s", async (kind) => {
  const url = "https://example.com/repeated-photos";
  const photo = { fileId: 41, dimensions: { width: 320, height: 240 }, spoiler: false };
  const article: NonNullable<ReturnType<typeof readInstantView>> = { rtl: false, partial: false, blocks: [{ kind,
    text: "Gallery", media: [
      { kind: "photo", text: "First caption", photo },
      { kind: "map", text: "A map", point: { latitude: 5, longitude: 6, zoom: 12 } },
      { kind: "photo", text: "Second caption", photo },
    ] }] };
  const loadPhoto = vi.fn(async (_source: string, _fileId: number) => ({ mime: "image/png" as const, base64: "AA==" }));
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}>
      <InstantViewPhotoLoader.Provider value={loadPhoto}><InstantViewButton url={url} /></InstantViewPhotoLoader.Provider>
    </InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    await screen.findByText("First caption");
    if (kind === "slideshow") {
      const navigation = screen.getByRole("group", { name: "Article slide navigation" });
      fireEvent.keyDown(navigation, { key: "End" });
    }
    const slide = screen.getByText("Second caption").closest("li")!;
    fireEvent.click(within(slide).getByRole("button", { name: "Show photo" }));
    fireEvent.click(await within(slide).findByRole("button", { name: "Enlarge Telegram photo" }));
    const viewer = within(screen.getByRole("dialog", { name: "Telegram photo viewer" }));
    expect(viewer.getByText("2 / 2")).toBeTruthy();
    expect(viewer.getByText("Second caption")).toBeTruthy();
    fireEvent.click(viewer.getByRole("button", { name: "Previous photo" }));
    expect(viewer.getByText("1 / 2")).toBeTruthy();
    expect(viewer.getByText("First caption")).toBeTruthy();
    await waitFor(() => expect(loadPhoto.mock.calls.length).toBeGreaterThan(1));
    expect(loadPhoto.mock.calls.every(([source, fileId]) => source === url && fileId === 41)).toBe(true);
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("keeps slideshow selections separate across visits to the same article", async () => {
  const source = "https://example.com/gallery";
  const linked = "https://example.com/linked";
  const link = (text: string, url: string) => ({ text, links: [{ offset: 0, length: text.length, url, instantView: true }] });
  const load = async (url: string) => schemas.instantView.output.parse({ rtl: false, partial: false,
    blocks: url === source ? [{ kind: "slideshow", text: "", media: [
      { kind: "audio", text: "First slide", audio: { fileId: 1, mime: "audio/ogg", voiceNote: true } },
      { kind: "audio", ...link("Open linked article", linked), audio: { fileId: 2, mime: "audio/ogg", voiceNote: true } },
    ] }] : [{ kind: "paragraph", ...link("Reopen gallery article", source) }],
  });
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", {
    configurable: true, value(this: HTMLDialogElement) { this.open = true; },
  });
  try {
    render(<InstantViewLoader.Provider value={load}><InstantViewButton url={source} /></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next slide" }));
    fireEvent.click(screen.getByRole("link", { name: "Open linked article" }));
    fireEvent.click(await screen.findByRole("link", { name: "Reopen gallery article" }));
    expect(await screen.findByText("First slide")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to article" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to article" }));
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Open linked article" }));
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("keeps an excerpt visible across a failed request and replaces it when the full Instant View arrives", async () => {
  const source = "https://example.com/fixture";
  const read = (full: boolean) => schemas.instantView.output.parse(readInstantView({
    "@type": "webPageInstantView", is_full: full, blocks: [
      { "@type": "pageBlockParagraph", text: { "@type": "richTextPlain", text: full ? "Full article fixture" : "Excerpt fixture" } },
    ],
  }, source));
  const excerpt = read(false);
  expect(excerpt).toMatchObject({ partial: true, incompleteSource: true });
  const load = vi.fn(async () => read(true)).mockResolvedValueOnce(excerpt).mockRejectedValueOnce(new Error("fixture failure"));
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={load}><InstantViewButton url={source} /></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const retry = await screen.findByRole("button", { name: "Retry full article" });
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    expect(await screen.findByText("Could not load the full article. The excerpt is still available.")).toBeTruthy();
    expect(screen.getByText("Excerpt fixture")).toBeTruthy();
    const dialog = screen.getByRole("dialog", { name: "Instant View" });
    dialog.scrollTop = 120;
    fireEvent.click(retry);
    expect(await screen.findByText("Full article fixture")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry full article" })).toBeNull();
    expect(dialog.scrollTop).toBe(120);
    expect(load.mock.calls).toHaveLength(3);
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("restores the visible paragraph when the full article inserts blocks above it", async () => {
  const excerpt = { rtl: false, partial: true, incompleteSource: true as const,
    blocks: [{ kind: "paragraph" as const, text: "Reading position fixture" }] };
  const load = vi.fn(async () => ({ rtl: false, partial: false,
    blocks: [{ kind: "paragraph" as const, text: "Inserted fixture" }, ...excerpt.blocks] })).mockResolvedValueOnce(excerpt);
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.matches("dialog[open]")) return new DOMRect(0, 0, 300, 320);
    if (this.matches(".mtg-instant-view-actions")) return new DOMRect(0, 0, 300, 60);
    if (this.textContent === "Reading position fixture") {
      return new DOMRect(0, this.dataset.articleBlock === "0" ? 54 : 174, 300, 34);
    }
    return new DOMRect();
  });
  try {
    render(<InstantViewLoader.Provider value={load}><InstantViewButton url="https://example.com/anchor" /></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const retry = await screen.findByRole("button", { name: "Retry full article" });
    const viewer = screen.getByRole("dialog");
    viewer.scrollTop = 200;
    fireEvent.click(retry);
    await screen.findByText("Inserted fixture");
    expect(viewer.scrollTop).toBe(320);
  } finally {
    bounds.mockRestore();
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("keeps concurrent full-article retries and reading position scoped to their own history entries", async () => {
  const source = "https://example.com/source";
  const linked = "https://example.com/linked";
  const paragraph = (text: string) => ({ kind: "paragraph" as const, text });
  const next = "Open linked excerpt";
  const sourceArticle = (incompleteSource: boolean) => schemas.instantView.output.parse({
    rtl: false, partial: incompleteSource, ...(incompleteSource && { incompleteSource: true }),
    blocks: [{ kind: "details", text: "Reading section", open: false, blocks: [
      { ...paragraph(next), links: [{ offset: 0, length: next.length, url: linked, instantView: true }] },
      paragraph(incompleteSource ? "Source excerpt" : "Complete source"),
    ] }, ...incompleteSource ? [] : [
      { kind: "details", text: "New section", open: true, blocks: [paragraph("New content")] },
    ]],
  });
  const linkedExcerpt = schemas.instantView.output.parse({
    rtl: false, partial: true, incompleteSource: true, blocks: [paragraph("Linked excerpt")],
  });
  let finishSource!: (value: ReturnType<typeof sourceArticle>) => void;
  let finishLinked!: (value: ReturnType<typeof sourceArticle>) => void;
  const sourceRequest = new Promise<ReturnType<typeof sourceArticle>>((resolve) => { finishSource = resolve; });
  const linkedRequest = new Promise<ReturnType<typeof sourceArticle>>((resolve) => { finishLinked = resolve; });
  const load = vi.fn()
    .mockResolvedValueOnce(sourceArticle(true)).mockReturnValueOnce(sourceRequest)
    .mockResolvedValueOnce(linkedExcerpt).mockReturnValueOnce(linkedRequest);
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={load}><InstantViewButton url={source} /></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry full article" }));
    const dialog = screen.getByRole("dialog", { name: "Instant View" });
    screen.getByText("Reading section").closest("details")!.open = true;
    dialog.scrollTop = 125;
    fireEvent.click(screen.getByRole("link", { name: next }));
    await screen.findByText("Linked excerpt");
    const retry = screen.getByRole<HTMLButtonElement>("button", { name: "Retry full article" });
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    dialog.scrollTop = 20;
    await act(async () => finishSource(sourceArticle(false)));
    expect(screen.getByText("Linked excerpt")).toBeTruthy();
    expect(retry.disabled).toBe(true);
    expect(dialog.scrollTop).toBe(20);
    fireEvent.click(screen.getByRole("button", { name: "Back to article" }));
    expect(screen.getByText("Complete source")).toBeTruthy();
    expect(screen.getByText("Reading section").closest("details")?.open).toBe(true);
    expect(screen.getByText("New section").closest("details")?.open).toBe(true);
    expect(dialog.scrollTop).toBe(125);
    expect(document.activeElement).toBe(screen.getByRole("link", { name: next }));
    await act(async () => finishLinked(sourceArticle(false)));
    expect(screen.getByText("Complete source")).toBeTruthy();
    expect(load.mock.calls).toEqual([[source], [source], [linked], [linked]]);
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test.each(["text", "button"])("opens a native Telegram link from Instant View %s inside BB", async (entry) => {
  const source = "https://example.com/fixture";
  const title = { "@type": "richTextPlain", text: "Open fixture" };
  const url = entry === "text" ? "https://t.me/boost/fixture" : "https://t.me/fixture/42";
  const block = entry === "text"
    ? { "@type": "pageBlockParagraph", text: { "@type": "richTextUrl", url: "tg://boost?domain=Fixture", text: title } }
    : { "@type": "pageBlockButtonRow", buttons: [{ "@type": "inlineButton", text: title,
      type: { "@type": "inlineKeyboardButtonTypeUrl", url: "tg://resolve?domain=Fixture&post=42" } }] };
  const article = schemas.instantView.output.parse(readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [block] }, source));
  expect(article?.blocks).toMatchObject(entry === "text" ? [{ links: [{ url }] }] : [{ buttons: [{ url }] }]);
  const open = vi.fn(async () => true);
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<OpenTelegramMessageLink.Provider value={open}><InstantViewLoader.Provider value={async () => article}>
      <InstantViewButton url={source} />
    </InstantViewLoader.Provider></OpenTelegramMessageLink.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    fireEvent.click(await screen.findByRole("link", { name: "Open fixture" }));
    await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith(url, expect.any(AbortSignal)));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Instant View" })).toBeNull());
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test.each([
  { mime: "image/gif", base64: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" },
  { mime: "image/webp", base64: "UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA" },
] as const)("renders a TDLib $mime icon inline through the article-scoped loader", async ({ mime, base64 }) => {
  const url = "https://example.com/inline";
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const article = schemas.instantView.output.parse(readInstantView({
    "@type": "webPageInstantView", is_full: true, blocks: [
      { "@type": "pageBlockParagraph", text: { "@type": "richTexts", texts: [
        plain("Before "), { "@type": "richTextIcon", width: 24, height: 18, document: {
          "@type": "document", mime_type: mime, document: { "@type": "file", id: 21, size: 42 },
        } }, plain(" after"),
      ] } },
    ],
  }, url));
  expect(article).toMatchObject({ partial: false, blocks: [{ icons: [{ offset: 7, fileId: 21, mime, width: 24, height: 18 }] }] });
  const load = vi.fn(async () => schemas.instantViewIcon.output.parse({ mime, base64 }));
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewIconLoader.Provider value={load}><InstantViewLoader.Provider value={async () => article}>
      <InstantViewButton url={url} />
    </InstantViewLoader.Provider></InstantViewIconLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.querySelector("p img")?.getAttribute("src")).toBe(`data:${mime};base64,${base64}`));
    expect(dialog.querySelector("p")?.textContent).toBe("Before  after");
    expect(load).toHaveBeenCalledExactlyOnceWith(url, 21);
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("opens cached inline article links in the viewer and restores the originating link", async () => {
  const source = "https://example.com/fixture";
  const next = "https://example.com/next#some%20section";
  const paragraph = (text: unknown) => ({ "@type": "pageBlockParagraph", text });
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const link = (text: string, url: string, is_cached: boolean) =>
    ({ "@type": "richTextUrl", url, is_cached, text: plain(text) });
  const read = (url: string) => schemas.instantView.output.parse(readInstantView({
    "@type": "webPageInstantView", is_full: true,
    blocks: url === source ? [
      paragraph(link("Cached article", next, true)),
      paragraph(link("Ordinary link", "https://example.com/ordinary", false)),
    ] : [{
      "@type": "pageBlockDetails", header: plain("Collapsed destination"), is_open: false, blocks: [
        { "@type": "pageBlockAnchor", name: "some section" },
        paragraph(plain("Destination article")),
      ],
    }],
  }, url));
  const load = vi.fn(async (url: string) => read(url));
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={load}><InstantViewButton url={source} /></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const cached = await screen.findByRole("link", { name: "Cached article" });
    const ordinary = screen.getByRole("link", { name: "Ordinary link" });
    expect(ordinary.getAttribute("target")).toBe("_blank");
    expect(ordinary.hasAttribute("data-article-navigation")).toBe(false);
    expect(fireEvent.click(cached, { metaKey: true })).toBe(true);
    expect(load.mock.calls).toEqual([[source]]);
    const dialog = screen.getByRole("dialog", { name: "Instant View" });
    dialog.scrollTop = 120;
    fireEvent.click(cached);
    const section = await within(dialog).findByText("Destination article");
    expect(section.closest("details")?.open).toBe(true);
    expect(document.activeElement).toBe(section);
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to article" }));
    expect(dialog.scrollTop).toBe(120);
    expect(document.activeElement).toBe(within(dialog).getByRole("link", { name: "Cached article" }));
    expect(load.mock.calls).toEqual([[source], [next]]);
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("autoplays a flagged visible article video muted and resumes it after a visibility pause", async () => {
  const observers: IntersectionObserverCallback[] = [];
  class Observer {
    constructor(callback: IntersectionObserverCallback) { observers.push(callback); }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value(this: HTMLDialogElement) { this.open = true; },
  });
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  try {
    const url = "https://example.com/movie";
    const load = async () => readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [...[1, 2].map((id) => ({
      "@type": "pageBlockVideo", need_autoplay: true, has_spoiler: id === 2,
      video: { "@type": "video", mime_type: "video/mp4", video: { "@type": "file", id, size: 8192 } },
    })), { "@type": "pageBlockAnimation", need_autoplay: true,
      animation: { "@type": "animation", mime_type: "image/gif", animation: { "@type": "file", id: 3, size: 8192 } },
    }, { "@type": "pageBlockVideo", need_autoplay: true,
      video: { "@type": "video", mime_type: "video/mp4", video: { "@type": "file", id: 4, size: 0, expected_size: 8192 } },
      caption: { text: { "@type": "richTextPlain", text: "Unknown size fixture" } },
    }] });
    const playback = vi.fn(async () => "/fixture/stream");
    render(<InstantViewLoader.Provider value={load}><InstantViewPlaybackLoader.Provider value={playback}>
      <MessageContent chatId="42" message={{ id: "20", text: url, author: "", time: "",
        linkPreview: { url, title: "Preview fixture", site: "", description: "", above: false, instantView: true } }} />
    </InstantViewPlaybackLoader.Provider></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    await screen.findByRole("button", { name: "Show video spoiler" });
    await waitFor(() => expect(observers).toHaveLength(2));
    expect(playback).not.toHaveBeenCalled();
    observers[0]!([{ isIntersecting: true, intersectionRatio: 0.6 } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(playback).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    const video = await screen.findByLabelText<HTMLVideoElement>("Telegram video");
    expect(video.muted).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(playback).toHaveBeenCalledExactlyOnceWith(url, 1);
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(pause).toHaveBeenCalledOnce();
    const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    expect(play).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close player" }));
    expect(screen.queryByLabelText("Telegram video")).toBeNull();
    expect(playback).toHaveBeenCalledTimes(1);
    const gifVisibility = (isIntersecting: boolean) => act(() =>
      observers[1]!([{ isIntersecting, intersectionRatio: isIntersecting ? 0.6 : 0 } as IntersectionObserverEntry], {} as IntersectionObserver));
    gifVisibility(true);
    expect(await screen.findByRole("img", { name: "Telegram image" })).toBeTruthy();
    gifVisibility(false);
    expect(screen.queryByRole("img", { name: "Telegram image" })).toBeNull();
    gifVisibility(true);
    expect(screen.getByRole("img", { name: "Telegram image" })).toBeTruthy();
    expect(playback.mock.calls).toEqual([[url, 1], [url, 3]]);
    const unknown = screen.getByText("Unknown size fixture").closest("figure")!;
    fireEvent.click(within(unknown).getByRole("button", { name: "Load video player" }));
    await within(unknown).findByLabelText("Telegram video");
    expect(playback).toHaveBeenLastCalledWith(url, 4);
  } finally {
    hidden.mockRestore();
    if (original) Object.defineProperty(HTMLDialogElement.prototype, "showModal", original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    vi.unstubAllGlobals();
  }
});

test("reads bounded article text from TDLib and marks unsupported blocks as partial", () => {
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const page = {
    "@type": "webPageInstantView",
    is_full: true,
    is_rtl: true,
    blocks: [
      { "@type": "pageBlockTitle", title: plain("Fixture") },
      { "@type": "pageBlockParagraph", text: { "@type": "richTexts", texts: [
        plain("Article "), { "@type": "richTextBold", text: plain("text") },
        { "@type": "richTextUrl", text: plain(" source"), url: "https://example.com/source" },
        { "@type": "richTextUrl", text: plain(" invalid"), url: "javascript:alert(1)" },
      ] } },
      { "@type": "pageBlockPhoto" },
      { "@type": "pageBlockPreformatted", text: plain("x".repeat(8300)), language: "typescript" },
    ],
  };
  const article = readInstantView(page);
  expect(article).toEqual({ rtl: true, partial: true, blocks: [
    { kind: "title", text: "Fixture" }, { kind: "paragraph", text: "Article text source invalid",
      styles: [{ offset: 8, length: 4, style: "bold" }],
      links: [{ offset: 12, length: 7, url: "https://example.com/source" }] },
    { kind: "code", text: "x".repeat(8192), language: "typescript" },
  ] });
  expect(readInstantView({ ...page, blocks: [] })).toBeNull();
});

test("preserves nested media and anchors inside a block quote", () => {
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const page = { "@type": "webPageInstantView", is_full: true, blocks: [{
    "@type": "pageBlockBlockQuote", credit: plain("Fixture credit"), page_blocks: [
      { "@type": "pageBlockParagraph", text: plain("Fixture quote") },
      { "@type": "pageBlockAnchor", name: "quoted-video" },
      { "@type": "pageBlockVideo", video: { "@type": "video", mime_type: "video/mp4",
        video: { "@type": "file", id: 81, size: 4096 } } },
    ],
  }] };
  const article = schemas.instantView.output.parse(readInstantView(page));
  expect(article).toMatchObject({ partial: false, blocks: [{
    kind: "richQuote", credit: { text: "Fixture credit" }, blocks: [
      { kind: "paragraph", text: "Fixture quote" },
      { kind: "video", anchors: ["quoted-video"], video: { fileId: 81 } },
    ],
  }] });
  expect(findInstantViewPlayback(page, 81)).toMatchObject({ id: 81, size: 4096, mime: "video/mp4" });
  expect(findInstantViewPlayback(page, 82)).toBeUndefined();
});

test("links public mentions in Instant View and keeps invalid mentions as plain text", () => {
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const mention = (text: string, username: string) => ({ "@type": "richTextMention", text: plain(text), username });
  const page = (texts: unknown[]) => ({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockParagraph", text: { "@type": "richTexts", texts } },
  ] });
  expect(schemas.instantView.output.parse(readInstantView(page([plain("📰 "), mention("Source", "Fixture_Channel")])))).toEqual({
    rtl: false, partial: false, blocks: [{ kind: "paragraph", text: "📰 Source",
      links: [{ offset: 3, length: 6, url: "https://t.me/fixture_channel" }] }],
  });
  expect(readInstantView(page([mention("Reserved", "joinchat"), plain(" "), mention("Invalid", "x?start=foo")]))).toEqual({
    rtl: false, partial: true, blocks: [{ kind: "paragraph", text: "Reserved Invalid" }],
  });
});

test("reads bounded display formulas and ignores oversized formulas", () => {
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockMathematicalExpression", expression: String.raw`\frac{a}{b}` },
    { "@type": "pageBlockMathematicalExpression", expression: "x".repeat(4097) },
  ] });
  expect(schemas.instantView.output.parse(article)).toMatchObject({
    partial: true, blocks: [{ kind: "math", text: String.raw`\frac{a}{b}` }],
  });
});

test("updates relative article dates while visible and catches up when the tab returns", async () => {
  const url = "https://example.com/date";
  const unixTime = 1700000000;
  const formatter = new Intl.RelativeTimeFormat();
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  vi.useFakeTimers();
  vi.setSystemTime((unixTime - 5) * 1000);
  try {
    render(<InstantViewLoader.Provider value={async () => ({ rtl: false, partial: false, blocks: [{
      kind: "paragraph", text: "event", dates: [{ offset: 0, length: 5, unixTime, format: { kind: "relative" } }],
    }] })}><InstantViewButton url={url} /></InstantViewLoader.Provider>);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Instant View" })));
    const time = screen.getByText(formatter.format(5, "second"));
    act(() => vi.advanceTimersByTime(1000));
    expect(time.textContent).toBe(formatter.format(4, "second"));

    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    act(() => vi.advanceTimersByTime(2000));
    expect(time.textContent).toBe(formatter.format(4, "second"));
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    expect(time.textContent).toBe(formatter.format(2, "second"));
  } finally {
    cleanup();
    vi.useRealTimers();
    hidden.mockRestore();
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("preserves original, relative and absolute date ranges in article text", () => {
  const datetime = (formatting_type: unknown) => ({
    "@type": "richTextDateTime", unix_time: 1700000000, formatting_type,
    text: { "@type": "richTextPlain", text: "event" },
  });
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockParagraph", text: { "@type": "richTexts", texts: [
      { "@type": "richTextPlain", text: "📅 " },
      datetime(null),
      datetime({ "@type": "dateTimeFormattingTypeRelative" }),
      datetime({ "@type": "dateTimeFormattingTypeAbsolute",
        date_precision: { "@type": "dateTimePartPrecisionLong" }, time_precision: { "@type": "dateTimePartPrecisionShort" },
        show_day_of_week: true }),
    ] } },
  ] });
  expect(schemas.instantView.output.parse(article)).toMatchObject({ partial: false, blocks: [{
    text: "📅 eventeventevent",
    dates: [
      { offset: 3, length: 5, unixTime: 1700000000, format: { kind: "original" } },
      { offset: 8, length: 5, unixTime: 1700000000, format: { kind: "relative" } },
      { offset: 13, length: 5, unixTime: 1700000000, format: { kind: "absolute", date: "long", time: "short", weekday: true } },
    ],
  }] });
});

test("preserves inline formulas and surrounding formatting with UTF-16 ranges", () => {
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const expression = String.raw`x^2`;
  const formula = { "@type": "richTextMathematicalExpression", expression };
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockParagraph", text: { "@type": "richTextBold", text: { "@type": "richTexts",
      texts: [plain("🧮 "), formula, plain(" done")] } } },
    { "@type": "pageBlockTable", caption: plain("Formula table"),
      cells: [[{ "@type": "pageBlockTableCell", text: formula, colspan: 1, rowspan: 1 }]] },
  ] });
  expect(schemas.instantView.output.parse(article)).toMatchObject({ partial: false, blocks: [
    { kind: "paragraph", text: "🧮 x^2 done", formulas: [{ offset: 3, length: 3 }],
      styles: [{ style: "bold", offset: 0, length: 11 }] },
    { kind: "table", rows: [[{ text: expression, formulas: [{ offset: 0, length: 3 }] }]] },
  ] });
});

test("keeps article custom emoji ranges and falls back to text for invalid identifiers", () => {
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockParagraph", text: { "@type": "richTexts", texts: [
      { "@type": "richTextPlain", text: "A " },
      { "@type": "richTextCustomEmoji", custom_emoji_id: "9007199254740993", alternative_text: "🙂" },
      { "@type": "richTextCustomEmoji", custom_emoji_id: "invalid", alternative_text: "✨" },
    ] } },
  ] });
  expect(schemas.instantView.output.parse(article)).toMatchObject({ partial: true, blocks: [
    { text: "A 🙂✨", customEmoji: [{ offset: 2, length: 2, id: "9007199254740993" }] },
  ] });
});

test("preserves article email and phone links without accepting mail headers", () => {
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockParagraph", text: { "@type": "richTexts", texts: [
      { "@type": "richTextEmailAddress", email_address: "fixture@example.com", text: plain("Email") },
      plain(" "),
      { "@type": "richTextPhoneNumber", phone_number: "+1 (202) 555-0100", text: plain("Phone") },
      { "@type": "richTextEmailAddress", email_address: "fixture@example.com?bcc=other@example.com", text: plain(" Invalid") },
    ] } },
  ] });
  expect(schemas.instantView.output.parse(article)).toMatchObject({ partial: true, blocks: [
    { text: "Email Phone Invalid", links: [
      { offset: 0, length: 5, url: "mailto:fixture@example.com" },
      { offset: 6, length: 5, url: "tel:+12025550100" },
    ] },
  ] });
});

test("preserves valid Telegram feedback links and rejects malformed bot destinations", () => {
  const page = { "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockParagraph", text: { "@type": "richTextPlain", text: "Fixture" } },
  ] };
  const feedback = { "@type": "internalLinkTypeBotStart", bot_username: "Previews", start_parameter: "webpage123", autostart: true };
  expect(schemas.instantView.output.parse(readInstantView({ ...page, feedback_link: feedback })))
    .toMatchObject({ feedbackUrl: "https://t.me/previews?start=webpage123" });
  expect(readInstantView({ ...page, feedback_link: { ...feedback, bot_username: "other/path" } }))
    .not.toHaveProperty("feedbackUrl");
});

test("preserves formatted author and publication date independently", () => {
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockAuthorDate", author: { "@type": "richTextBold", text: plain("Writer") }, publish_date: 1700000000 },
    { "@type": "pageBlockAuthorDate", author: plain(""), publish_date: 1700000000 },
    { "@type": "pageBlockAuthorDate", author: plain("Other writer"), publish_date: 0 },
    { "@type": "pageBlockAuthorDate", author: plain(""), publish_date: -1 },
  ] });
  expect(schemas.instantView.output.parse(article)).toMatchObject({ partial: false, blocks: [
    { kind: "byline", text: "Writer", styles: [{ offset: 0, length: 6, style: "bold" }], publishedAt: 1700000000 },
    { kind: "byline", text: "", publishedAt: 1700000000 },
    { kind: "byline", text: "Other writer", publishedAt: undefined },
  ] });
});

test("preserves block and inline anchors with same-page links", () => {
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const url = "https://example.com/story";
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockParagraph", text: { "@type": "richTextAnchorLink", text: plain("Jump"),
      anchor_name: "details 50%", url: "https://example.com/story#details" } },
    { "@type": "pageBlockAnchor", name: "details 50%" },
    { "@type": "pageBlockHeader", header: { "@type": "richTexts", texts: [
      { "@type": "richTextAnchor", name: "details-alias" }, plain("Details"),
    ] } },
  ] }, url);
  expect(article).toEqual({ rtl: false, partial: false, blocks: [
    { kind: "paragraph", text: "Jump", links: [{ offset: 0, length: 4, url: url + "#details%2050%25" }] },
    { kind: "heading", text: "Details", anchors: ["details 50%", "details-alias"] },
  ] });
});

test("follows accented trailing anchors and restores scroll, focus and disclosures when going back", async () => {
  const url = "https://example.com/story";
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const anchor = (name: string) => ({ "@type": "pageBlockAnchor", name });
  const jump = (text: string, name: string) => ({ "@type": "pageBlockParagraph",
    text: { "@type": "richTextAnchorLink", text: plain(text), anchor_name: name, url: url + "#" + name },
  });
  const page = { "@type": "webPageInstantView", is_full: true, blocks: [
    jump("Jump to section end", "séction-end".normalize("NFD")), jump("Jump to article end", "article-end"),
    { "@type": "pageBlockDetails", header: plain("Section fixture"), is_open: false,
      blocks: [{ "@type": "pageBlockParagraph", text: plain("Section body") }, anchor("séction-end")] },
    anchor("article-end"),
  ] };
  const article = schemas.instantView.output.parse(readInstantView(page, url));
  expect(article?.partial).toBe(false);
  expect(readInstantView({ ...page, blocks: [anchor("article-end")] }, url)).toBeNull();
  const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value(this: HTMLDialogElement) { this.open = true; },
  });
  try {
    const load = vi.fn(async () => article);
    render(<InstantViewLoader.Provider value={load}>
      <MessageContent chatId="42" message={{ id: "20", text: url, author: "", time: "",
        linkPreview: { url, title: "Preview fixture", site: "", description: "", above: false, instantView: true } }} />
    </InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const dialog = screen.getByRole("dialog", { name: "Instant View" });
    const jumpToSection = await within(dialog).findByRole("link", { name: "Jump to section end" });
    const section = within(dialog).getByText("Section fixture").closest("details")!;
    expect(section.open).toBe(false);
    dialog.scrollTop = 135;
    expect(fireEvent.click(jumpToSection)).toBe(false);
    expect(section.open).toBe(true);
    expect(document.activeElement).toBe(section.lastElementChild);
    const jumpToEnd = within(dialog).getByRole("link", { name: "Jump to article end" });
    dialog.scrollTop = 260;
    expect(fireEvent.click(jumpToEnd)).toBe(false);
    expect(document.activeElement?.previousElementSibling).toBe(section);
    const back = within(dialog).getByRole("button", { name: "Back to previous section" });
    fireEvent.click(back);
    expect(document.activeElement).toBe(jumpToEnd);
    expect(dialog.scrollTop).toBe(260);
    expect(section.open).toBe(true);
    fireEvent.click(back);
    expect(document.activeElement).toBe(jumpToSection);
    expect(dialog.scrollTop).toBe(135);
    expect(section.open).toBe(false);
    expect(within(dialog).queryByRole("button", { name: "Back to previous section" })).toBeNull();
    expect(load).toHaveBeenCalledExactlyOnceWith(url);
  } finally {
    if (original) Object.defineProperty(HTMLDialogElement.prototype, "showModal", original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  }
});

test.each(["legacy", "current"])("links to a named article reference using the %s TDLib format", (format) => {
  const url = "https://example.com/story";
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const source = "source 1";
  const fallbackUrl = url + "#source";
  const formattedSource = { "@type": "richTextItalic", text: plain("Source") };
  const link = format === "legacy"
    ? { "@type": "richTextReference", anchor_name: source, url: fallbackUrl, text: plain("[1]") }
    : { "@type": "richTextReferenceLink", reference_name: source, url: fallbackUrl, text: plain("[1]") };
  const target = format === "legacy"
    ? { "@type": "richTexts", texts: [{ "@type": "richTextAnchor", name: source }, formattedSource] }
    : { "@type": "richTextReference", name: source, text: formattedSource };
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockParagraph", text: link },
    { "@type": "pageBlockParagraph", text: target },
  ] }, url);
  expect(article).toEqual({ rtl: false, partial: false, blocks: [
    { kind: "paragraph", text: "[1]", links: [{ offset: 0, length: 3, url: url + "#source%201" }] },
    { kind: "paragraph", text: "Source", styles: [{ offset: 0, length: 6, style: "italic" }], anchors: ["source 1"] },
  ] });
});

test("retains article hashtags and cashtags with their rich-text offsets", () => {
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const page = { "@type": "webPageInstantView", is_full: true, blocks: [{ "@type": "pageBlockParagraph",
    text: { "@type": "richTexts", texts: [plain("🧪 "),
      { "@type": "richTextHashtag", hashtag: "Тест", text: { "@type": "richTextBold", text: plain("#Тест") } },
      plain(" "), { "@type": "richTextCashtag", cashtag: "$FIX", text: plain("$FIX") },
    ] },
  }] };
  expect(schemas.instantView.output.parse(readInstantView(page))).toEqual({ rtl: false, partial: false, blocks: [{
    kind: "paragraph", text: "🧪 #Тест $FIX", styles: [{ offset: 3, length: 5, style: "bold" }],
    tags: [{ offset: 3, length: 5, tag: "#Тест" }, { offset: 9, length: 4, tag: "$FIX" }],
  }] });
});

test("preserves voice notes and FLAC in article galleries and scopes playback to their files", () => {
  const voice = { "@type": "pageBlockVoiceNote", voice_note: {
    "@type": "voiceNote", mime_type: "audio/ogg", duration: 12, waveform: "Hw==",
    voice: { "@type": "file", id: 42, size: 2048 },
  }, caption: { text: { "@type": "richTextReference", name: "voice",
    text: { "@type": "richTextPlain", text: "Voice slide" } } } };
  const audio = { "@type": "pageBlockAudio", audio: {
    "@type": "audio", mime_type: "audio/x-flac", audio: { "@type": "file", id: 43, size: 4096 },
  } };
  const page = { "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockSlideshow", blocks: [{ "@type": "pageBlockAnchor", name: "voice-slide" }, voice, audio] },
  ] };
  expect(schemas.instantView.output.parse(readInstantView(page))).toMatchObject({ partial: false, blocks: [
    { kind: "slideshow", media: [{ kind: "audio", text: "Voice slide", anchors: ["voice-slide", "voice"],
      audio: { fileId: 42, mime: "audio/ogg", voiceNote: true, durationSeconds: 12, waveform: [31] } },
    { kind: "audio", audio: { fileId: 43, mime: "audio/flac", voiceNote: false,
      document: { name: "Telegram media.flac", sizeBytes: 4096 } } }] },
  ] });
  expect(findInstantViewPlayback(page, 42)).toEqual({ kind: "audio", id: 42, mime: "audio/ogg", size: 2048 });
  expect(findInstantViewPlayback(page, 43)).toEqual({ kind: "audio", id: 43, mime: "audio/flac", size: 4096 });
  expect(findInstantViewPlayback(page, 44)).toBeUndefined();
});

test("displays article track metadata and loads only the selected cover in a slideshow", async () => {
  const thumbnail = (id: number, format = "thumbnailFormatJpeg") => ({
    "@type": "thumbnail", format: { "@type": format }, file: { "@type": "file", id, size: 2048 },
  });
  const track = (id: number, label: string, cover: unknown, fallback: unknown[]) => ({
    "@type": "pageBlockAudio", audio: { "@type": "audio", title: `  ${label}  `, performer: "Fixture performer",
      mime_type: "audio/mpeg", audio: { "@type": "file", id, size: 4096 },
      album_cover_thumbnail: cover, external_album_covers: fallback },
  });
  const page = articlePage([{ "@type": "pageBlockSlideshow", blocks: [
    track(43, "First track", thumbnail(75), [thumbnail(76)]),
    track(44, "Second track", thumbnail(77, "thumbnailFormatMpeg4"), [thumbnail(78)]),
  ] }]);
  const article = schemas.instantView.output.parse(readInstantView(page));
  expect(article).toMatchObject({ partial: false, blocks: [{ kind: "slideshow", media: [
    { audio: { audioTrack: { title: "First track", artist: "Fixture performer" }, coverFileId: 75 } },
    { audio: { audioTrack: { title: "Second track", artist: "Fixture performer" }, coverFileId: 78 } },
  ] }] });
  expect(findInstantViewPhoto(page, 75, () => undefined)).toEqual({ preview: 75, large: 75 });
  expect(findInstantViewPhoto(page, 78, () => undefined)).toEqual({ preview: 78, large: 78 });
  for (const id of [43, 76, 77]) expect(findInstantViewPhoto(page, id, () => undefined)).toBeUndefined();
  const url = "https://example.com/album";
  const loadCover = vi.fn(async () => ({ mime: "image/jpeg" as const, base64: "YQ==" }));
  const loadPlayback = vi.fn(async () => "/audio/fixture");
  const mediaSession = { metadata: null, playbackState: "none", setActionHandler: vi.fn() };
  const originalMediaSession = Object.getOwnPropertyDescriptor(navigator, "mediaSession");
  Object.defineProperty(navigator, "mediaSession", { configurable: true, value: mediaSession });
  vi.stubGlobal("MediaMetadata", class { constructor(value: object) { Object.assign(this, value); } });
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}>
      <InstantViewPhotoLoader.Provider value={loadCover}>
        <InstantViewPlaybackLoader.Provider value={loadPlayback}>
          <InstantViewButton url={url} />
        </InstantViewPlaybackLoader.Provider>
      </InstantViewPhotoLoader.Provider>
    </InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    await screen.findByText("First track");
    await waitFor(() => expect(loadCover).toHaveBeenCalledExactlyOnceWith(url, 75));
    expect(screen.queryByText("Second track")).toBeNull();
    expect(loadPlayback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    await screen.findByText("Second track");
    expect(screen.getByText("Fixture performer")).toBeTruthy();
    await waitFor(() => expect(loadCover.mock.calls).toEqual([[url, 75], [url, 78]]));
    const covers = document.querySelectorAll(".mtg-instant-view-audio-track img");
    expect(covers).toHaveLength(1);
    expect((covers[0] as HTMLImageElement).src).toBe("data:image/jpeg;base64,YQ==");
    fireEvent.click(screen.getByRole("button", { name: "Load audio player" }));
    const audio = await screen.findByLabelText("Telegram audio");
    fireEvent.play(audio);
    expect(loadPlayback).toHaveBeenCalledExactlyOnceWith(url, 44);
    expect(mediaSession.metadata).toMatchObject({ title: "Second track", artist: "Fixture performer" });
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    if (originalMediaSession) Object.defineProperty(navigator, "mediaSession", originalMediaSession);
    else Reflect.deleteProperty(navigator, "mediaSession");
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("preserves table headers, spans, alignment and captions from TDLib", () => {
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  expect(readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockTable", caption: plain("Results"), is_bordered: true, is_striped: true,
      cells: [[{ "@type": "pageBlockTableCell", text: plain("Total"), is_header: true, colspan: 2, rowspan: 1,
        align: { "@type": "pageBlockHorizontalAlignmentCenter" },
        valign: { "@type": "pageBlockVerticalAlignmentBottom" } },
        { "@type": "pageBlockTableCell", text: null, colspan: 1, rowspan: 1 }]] },
  ] })).toMatchObject({ partial: false, blocks: [
    { kind: "table", text: "Results", bordered: true, striped: true, compact: false,
      rows: [[{ text: "Total", header: true, colSpan: 2, rowSpan: 1, align: "center", verticalAlign: "bottom" },
        { text: "", invisible: true, colSpan: 1, rowSpan: 1 }]] },
  ] });
});

test("does not flag a table with an optional absent caption as incomplete", () => {
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockTable", caption: null, cells: [[{
      "@type": "pageBlockTableCell", text: { "@type": "richTextPlain", text: "Fixture cell" },
    }]] },
  ] });
  expect(schemas.instantView.output.parse(article)).toMatchObject({ partial: false, blocks: [
    { kind: "table", text: "", rows: [[{ text: "Fixture cell" }]] },
  ] });
});

test("copies an article table with merged cells and concealed spoilers", async () => {
  const url = "https://example.com/table";
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const cell = (text: unknown, colspan = 1, rowspan = 1) => ({ "@type": "pageBlockTableCell", text, colspan, rowspan });
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockTable", caption: plain("Results"), cells: [
      [cell(plain("Left"), 1, 2), cell(plain("Across"), 2)],
      [cell(plain("Two\nlines")), cell({ "@type": "richTextSpoiler", text: plain("Hidden detail") })],
      [cell(plain("Bottom")), cell(null), cell(plain("End"))],
    ] },
  ] }, url);
  const copy = vi.fn(async (_text: string) => {});
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}>
      <InstantViewButton url={url} />
    </InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy table" }));
    await waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith("Left\tAcross\t\n\tTwo lines\t[Spoiler]\nBottom\t\tEnd"));
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("scrolls to a named table cell in a collapsed article section", async () => {
  const url = "https://example.com/table";
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const article = schemas.instantView.output.parse(readInstantView({
    "@type": "webPageInstantView", is_full: true, blocks: [
      { "@type": "pageBlockParagraph", text: { "@type": "richTextReferenceLink", reference_name: "row 2",
        url: url + "#row%202", text: plain("Jump to total") } },
      { "@type": "pageBlockDetails", header: plain("Report"), is_open: false, blocks: [
        { "@type": "pageBlockTable", caption: plain("Results"), cells: [
          [{ "@type": "pageBlockTableCell", text: plain("Summary"), is_header: true }],
          [{ "@type": "pageBlockTableCell", text: { "@type": "richTextReference", name: "row 2", text: plain("Total") } }],
        ] },
      ] },
    ],
  }, url));
  expect(article).toMatchObject({ partial: false, blocks: [{ kind: "paragraph" }, { kind: "details", blocks: [
    { kind: "table", rows: [[{ text: "Summary" }], [{ text: "Total", anchors: ["row 2"] }]] },
  ] }] });
  const load = vi.fn(async () => article);
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={load}><InstantViewButton url={url} /></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const jump = await screen.findByRole("link", { name: "Jump to total" });
    const section = screen.getByText("Report").closest("details");
    expect(section?.open).toBe(false);
    fireEvent.click(jump);
    expect(section?.open).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("cell", { name: "Total" }));
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test.each(["ordinary", "expandable", "with nested blocks"])("focuses article references in a quote %s", async (variant) => {
  const url = "https://example.com/quoted-references";
  const reference = (name: string, text: string) => ({
    "@type": "richTextReference", name, text: articleText(text),
  });
  const link = (anchor_name: string, text: string) => ({
    "@type": "richTextAnchorLink", anchor_name, url: url + "#" + anchor_name, text: articleText(text),
  });
  const quotedText = reference("quote-body", "Target paragraph");
  const credit = reference("quote-credit", "Quote attribution");
  const expandable = variant === "expandable";
  const article = schemas.instantView.output.parse(readInstantView(articlePage([
    { "@type": "pageBlockParagraph", text: { "@type": "richTexts", texts: [
      link("quote-body", "Read the quote"), articleText(" "), link("quote-credit", "Read the attribution"),
    ] } },
    expandable ? { "@type": "pageBlockExpandableBlockQuote", text: quotedText, credit } : {
      "@type": "pageBlockBlockQuote", credit, blocks: [articleParagraph("Introduction"),
        ...(variant === "with nested blocks" ? [{ "@type": "pageBlockDivider" }] : []),
        { "@type": "pageBlockParagraph", text: quotedText }],
    },
  ]), url));
  expect(article?.partial).toBe(false);
  const load = vi.fn(async () => article);
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={load}><InstantViewButton url={url} /></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const toQuote = await screen.findByRole("link", { name: "Read the quote" });
    const toCredit = screen.getByRole("link", { name: "Read the attribution" });
    const paragraph = screen.getByText("Target paragraph").closest("p");
    const attribution = screen.getByText("Quote attribution").closest("footer");
    const disclosure = paragraph?.closest("details");
    expect(disclosure?.open).toBe(expandable ? false : undefined);
    for (const [opener, target] of [[toQuote, paragraph], [toCredit, attribution]] as const) {
      fireEvent.click(opener);
      expect(document.activeElement).toBe(target);
      expect(disclosure?.open).toBe(expandable ? true : undefined);
      fireEvent.click(screen.getByRole("button", { name: "Back to previous section" }));
      expect(document.activeElement).toBe(opener);
      expect(disclosure?.open).toBe(expandable ? false : undefined);
    }
    expect(load).toHaveBeenCalledExactlyOnceWith(url);
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("preserves the numbering and static checkbox state of nested list items", () => {
  const paragraph = (text: string) => ({ "@type": "pageBlockParagraph", text: { "@type": "richTextPlain", text } });
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockList", items: [{ "@type": "pageBlockListItem", label: "", type: "a", value: 3,
      blocks: [paragraph("Third"), { "@type": "pageBlockList", items: [
        { "@type": "pageBlockListItem", has_checkbox: true, is_checked: true, blocks: [paragraph("Nested task")] },
      ] }] }] },
  ] });
  expect(article).toMatchObject({ partial: false, blocks: [
    { kind: "list", items: [{ numbering: "a", value: 3, blocks: [
      { kind: "paragraph", text: "Third" }, { kind: "list", items: [
        { checked: true, blocks: [{ kind: "paragraph", text: "Nested task" }] },
      ] },
    ] }] },
  ] });
});

test("reads nested lists from legacy TDLib page_blocks", () => {
  const paragraph = (text: string) => ({ "@type": "pageBlockParagraph", text: { "@type": "richTextPlain", text } });
  const list = (label: string, page_blocks: unknown[]) => ({
    "@type": "pageBlockList", items: [{ "@type": "pageBlockListItem", label, page_blocks }],
  });
  const page = { "@type": "webPageInstantView", is_full: true, page_blocks: [
    list("3.", [paragraph("Outer"), list("a.", [paragraph("Inner")])]),
  ] };
  expect(schemas.instantView.output.parse(readInstantView(page))).toMatchObject({ partial: false, blocks: [
    { kind: "list", items: [{ label: "3.", blocks: [
      { text: "Outer" }, { kind: "list", items: [{ label: "a.", blocks: [{ text: "Inner" }] }] },
    ] }] },
  ] });
});

test("reads TDLib quote paragraphs, attribution and section blocks", () => {
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const paragraph = (text: string) => ({ "@type": "pageBlockParagraph", text: plain(text) });
  expect(readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockBlockQuote", blocks: [paragraph("First"), paragraph("Second")], credit: plain("Source") },
    { "@type": "pageBlockExpandableBlockQuote", text: plain("More"), credit: plain("") },
    { "@type": "pageBlockDivider" },
    { "@type": "pageBlockSectionHeading", text: plain("Section"), size: 4 },
    { "@type": "pageBlockSubheader", subheader: plain("Subheader") },
    { "@type": "pageBlockSectionHeading", text: plain("Default heading"), size: 7 },
    { "@type": "pageBlockFooter", footer: plain("Footer") },
  ] })).toMatchObject({ partial: false, blocks: [
    { kind: "quoteGroup", expandable: false, paragraphs: [{ text: "First" }, { text: "Second" }], credit: { text: "Source" } },
    { kind: "quoteGroup", expandable: true, paragraphs: [{ text: "More" }] },
    { kind: "divider" }, { kind: "heading", text: "Section", level: 4 }, { kind: "heading", text: "Subheader", level: 3 },
    { kind: "heading", text: "Default heading" }, { kind: "footer", text: "Footer" },
  ] });
});

test("keeps article typography and full code controls inside nested quotes", async () => {
  const page = articlePage([
    { "@type": "pageBlockKicker", kicker: articleText("Fixture section") },
    { "@type": "pageBlockTitle", title: articleText("Fixture headline") },
    { "@type": "pageBlockSubtitle", subtitle: articleText("Fixture subheading") },
    { "@type": "pageBlockBlockQuote", blocks: [
      { "@type": "pageBlockPreformatted", language: "js", text: articleText("const fixture = 1;") },
      { "@type": "pageBlockBlockQuote", blocks: [articleParagraph("Fixture nested quote")] },
    ] },
    { "@type": "pageBlockPullQuote", text: articleText("Fixture pull quote"), credit: articleText("Fixture attribution") },
    { "@type": "pageBlockFooter", footer: articleText("Fixture footer") },
  ]);
  const article = schemas.instantView.output.parse(readInstantView(page));
  expect(article?.partial).toBe(false);
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}><InstantViewButton url="https://example.com/layout" /></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Fixture headline" })).toBeTruthy();
    expect(screen.getByText("Fixture section").closest("[data-article-kind]")?.getAttribute("data-article-kind")).toBe("kicker");
    expect(screen.getByText("Fixture subheading").closest("p")?.dataset.articleKind).toBe("subtitle");
    const code = screen.getByRole("button", { name: "Copy code" }).closest("blockquote");
    expect(code?.querySelector("code")?.textContent).toBe("const fixture = 1;");
    expect(within(code!).getByText("js")).toBeTruthy();
    expect(code?.querySelector("blockquote")?.textContent).toBe("Fixture nested quote");
    expect(screen.getByText("Fixture pull quote").closest("blockquote")?.dataset.pull).toBe("true");
    expect(screen.getByText("Fixture attribution").closest("footer")).toBeTruthy();
    expect(screen.getByText("Fixture footer").closest("footer")?.dataset.articleKind).toBe("footer");
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test.each(["blocks", "page_blocks"])("preserves nested disclosure blocks and resolves article media with %s", (field) => {
  const plain = (text: string) => ({ "@type": "richTextPlain", text });
  const details = (header: string, is_open: boolean, blocks: unknown[]) =>
    ({ "@type": "pageBlockDetails", header: plain(header), is_open, [field]: blocks });
  const blocks = [details("Outer", false, [
    details("Inner", true, [
      { "@type": "pageBlockAnchor", name: "fixture" },
      { "@type": "pageBlockParagraph", text: plain("Nested text") },
      { "@type": "pageBlockPhoto", photo: { "@type": "photo", sizes: [] }, url: "https://example.com/photo-source" },
      { "@type": "pageBlockVideo", video: { "@type": "video", mime_type: "video/mp4",
        video: { "@type": "file", id: 42, size: 123 } } },
    ]),
  ])];
  const page = { "@type": "webPageInstantView", is_full: true, [field]: blocks };
  const selectPhoto = () => ({ preview: 51, large: 52, dimensions: { width: 640, height: 480 } });
  const article = schemas.instantView.output.parse(readInstantView(page, undefined, selectPhoto));
  expect(article).toMatchObject({ partial: false, blocks: [
    { kind: "details", text: "Outer", open: false, blocks: [
      { kind: "details", text: "Inner", open: true, blocks: [
        { kind: "paragraph", text: "Nested text", anchors: ["fixture"] },
        { kind: "photo", photo: { fileId: 52 }, url: "https://example.com/photo-source" },
        { kind: "video", video: { fileId: 42 } },
      ] },
    ] },
  ] });
  const unsafe = { ...page, [field]: [{ "@type": "pageBlockPhoto", url: "javascript:void(0)" }] };
  expect(readInstantView(unsafe, undefined, selectPhoto)?.blocks[0]).not.toHaveProperty("url");
  expect(findInstantViewPhoto(page, 52, selectPhoto)?.large).toBe(52);
  expect(findInstantViewPlayback(page, 42)?.id).toBe(42);
  const oversized = { ...page, [field]: [
    details("Many blocks", false, Array.from({ length: 199 }, () => ({ "@type": "pageBlockParagraph", text: plain("Fixture") }))),
    ...blocks,
  ] };
  expect(readInstantView(oversized)?.partial).toBe(true);
  expect(findInstantViewPlayback(oversized, 42)).toBeUndefined();
});

test("keeps related article metadata and discards non-web destinations", () => {
  expect(readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockRelatedArticles", header: { "@type": "richTextPlain", text: "Further reading" }, articles: [
      { "@type": "pageBlockRelatedArticle", url: "https://example.com/next", title: "Next article",
        description: "A summary", author: "Fixture author", publish_date: 1710000000 },
      { "@type": "pageBlockRelatedArticle", url: "javascript:alert(1)", title: "Invalid article" },
    ] },
  ] })).toEqual({ rtl: false, partial: true, blocks: [
    { kind: "related", text: "Further reading", articles: [
      { url: "https://example.com/next", title: "Next article", description: "A summary",
        author: "Fixture author", publishedAt: 1710000000 },
    ] },
  ] });
});

test("preserves embedded posts with captions and scoped media and discards unsafe source URLs", () => {
  const post = { "@type": "pageBlockEmbeddedPost", url: "https://t.me/fixture_channel/42", author: "Fixture author",
    date: 1700000000, author_photo: { "@type": "photo", sizes: [] }, caption: { "@type": "pageBlockCaption", text: { "@type": "richTextPlain", text: "Post caption" } },
    blocks: [
      { "@type": "pageBlockAnchor", name: "post-body" },
      { "@type": "pageBlockVideo", video: { "@type": "video", mime_type: "video/mp4",
        video: { "@type": "file", id: 42, size: 123 } } },
    ],
  };
  const page = { "@type": "webPageInstantView", is_full: true,
    blocks: [post, { ...post, url: "javascript:void(0)", blocks: [] }] };
  const selectPhoto = () => ({ preview: 91, large: 95, dimensions: { width: 128, height: 128 } });
  expect(schemas.instantView.output.parse(readInstantView(page, undefined, selectPhoto))).toMatchObject({ partial: true, blocks: [
    { kind: "embeddedPost", source: post.url, author: post.author, avatarFileId: 91, publishedAt: post.date, text: "Post caption",
      blocks: [{ kind: "video", anchors: ["post-body"], video: { fileId: 42 } }] },
    { kind: "embeddedPost", source: undefined, text: "Post caption", blocks: [] },
  ] });
  expect(findInstantViewPlayback(page, 42)?.id).toBe(42);
  expect(findInstantViewPhoto(page, 91, selectPhoto)).toEqual({ preview: 91, large: 91 });
  expect(findInstantViewPhoto(page, 95, selectPhoto)).toBeUndefined();
});

test("reads aligned article buttons and disables unsupported or unsafe actions", () => {
  const button = (text: string, type: unknown) => ({ "@type": "inlineButton",
    text: { "@type": "richTextPlain", text }, type });
  const page = { "@type": "webPageInstantView", is_full: true, blocks: [{
    "@type": "pageBlockButtonRow", align: { "@type": "pageBlockHorizontalAlignmentCenter" }, buttons: [
      button("Open fixture", { "@type": "inlineKeyboardButtonTypeUrl", url: "https://example.com/" }),
      button("Copy fixture", { "@type": "inlineKeyboardButtonTypeCopyText", text: "Fixture code" }),
      button("Unsafe", { "@type": "inlineKeyboardButtonTypeUrl", url: "javascript:void(0)" }),
      button("Callback", { "@type": "inlineKeyboardButtonTypeCallback", data: "AA==" }),
    ],
  }] };
  expect(schemas.instantView.output.parse(readInstantView(page))).toEqual({ rtl: false, partial: true, blocks: [
    { kind: "buttons", text: "", align: "center", buttons: [
      { kind: "url", label: "Open fixture", url: "https://example.com/" },
      { kind: "copy", label: "Copy fixture", text: "Fixture code" },
      { kind: "disabled", label: "Unsafe" },
      { kind: "disabled", label: "Callback" },
    ] },
  ] });
});

test("validates article attachment references and sanitizes the download filename", () => {
  const page = { "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockDocument", document: { "@type": "document", file_name: "../Article.txt",
      document: { "@type": "file", id: 51, size: 1024 } } },
  ] };
  const document = { name: "_Article.txt", downloadable: true, sizeBytes: 1024, approximateSize: false };
  expect(schemas.instantView.output.parse(readInstantView(page))?.blocks).toEqual([
    { kind: "document", text: "", fileId: 51, document },
  ]);
  expect(findInstantViewDocument(page, 51)).toEqual({ fileId: 51, document });
  expect(findInstantViewDocument(page, 52)).toBeUndefined();
});

test("preserves nested attachments and their anchors inside article list items", () => {
  const page = { "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockList", items: [{ "@type": "pageBlockListItem", blocks: [
      { "@type": "pageBlockAnchor", name: "attachment" },
      { "@type": "pageBlockDocument", document: { "@type": "document", file_name: "Reference.txt",
        document: { "@type": "file", id: 71, size: 1024 } } },
    ] }] },
  ] };
  const document = { name: "Reference.txt", downloadable: true, sizeBytes: 1024, approximateSize: false };
  expect(schemas.instantView.output.parse(readInstantView(page))).toMatchObject({
    partial: false, blocks: [{ kind: "list", items: [{ blocks: [
      { kind: "document", anchors: ["attachment"], fileId: 71, document },
    ] }] }],
  });
  expect(findInstantViewDocument(page, 71)).toEqual({ fileId: 71, document });
  expect(findInstantViewDocument(page, 72)).toBeUndefined();
});

test("reads article map dimensions, preserving the ratio within TDLib preview limits", () => {
  const map = { "@type": "pageBlockMap", zoom: 9, width: 1600, height: 800,
    location: { "@type": "location", latitude: 5, longitude: 6 },
    caption: { "@type": "pageBlockCaption", text: { "@type": "richTextPlain", text: "Map fixture" } } };
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true,
    blocks: [map, { ...map, width: 0 }, { ...map, location: { ...map.location, latitude: 91 } }] });
  expect(schemas.instantView.output.parse(article)).toEqual({ rtl: false, partial: true, blocks: [
    { kind: "map", text: "Map fixture", point: { latitude: 5, longitude: 6, zoom: 13, dimensions: { width: 1024, height: 512 } } },
    { kind: "map", text: "Map fixture", point: { latitude: 5, longitude: 6, zoom: 13 } },
    { kind: "missingMedia", text: "Map fixture" },
  ] });
});

test.each([
  ["pageBlockCollage", "Article collage"],
  ["pageBlockSlideshow", "Article slides"],
])("renders a map in a %s and loads its preview on request", async (type, region) => {
  const url = "https://example.com/article";
  const map = { "@type": "pageBlockMap", zoom: 9, width: 600, height: 400,
    location: { "@type": "location", latitude: 5, longitude: 6 },
    caption: { "@type": "pageBlockCaption", text: { "@type": "richTextPlain", text: "Gallery map" } } };
  const page = { "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": type, blocks: [map] },
  ] };
  const point = { latitude: 5, longitude: 6, zoom: 13, dimensions: { width: 600, height: 400 } };
  const article = schemas.instantView.output.parse(readInstantView(page));
  expect(article).toMatchObject({ partial: false, blocks: [{ media: [{ kind: "map", point }] }] });
  expect(findInstantViewMap(page, point)).toEqual(point);
  expect(findInstantViewMap(page, { ...point, longitude: 7 })).toBeUndefined();

  const loadMap = vi.fn(async () => "AA==");
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}>
      <InstantViewMapLoader.Provider value={loadMap}><InstantViewButton url={url} /></InstantViewMapLoader.Provider>
    </InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const gallery = within(await screen.findByRole("list", { name: region }));
    expect(gallery.getByText("Gallery map")).toBeTruthy();
    expect(loadMap).not.toHaveBeenCalled();
    fireEvent.click(gallery.getByRole("button", { name: "Show map preview" }));
    await waitFor(() => expect(loadMap).toHaveBeenCalledExactlyOnceWith(url, point));
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("keeps an embed poster, caption, dimensions and web link within the HTML budget", () => {
  const embed = { "@type": "pageBlockEmbedded", url: "https://example.com/embed", html: "x".repeat(32769),
    width: 560, height: 315, is_full_width: true, allow_scrolling: true,
    poster_photo: { "@type": "photo", sizes: [] },
    caption: { "@type": "pageBlockCaption", text: { "@type": "richTextPlain", text: "Embed description" } } };
  const page = (block: unknown) => ({ "@type": "webPageInstantView", is_full: true, blocks: [block] });
  const selectPhoto = (sizes: unknown) => Array.isArray(sizes)
    ? { preview: 96, large: 97, dimensions: { width: 640, height: 480 } } : undefined;
  const article = schemas.instantView.output.parse(readInstantView(page(embed), undefined, selectPhoto));
  expect(article).toMatchObject({ partial: true, blocks: [
    { kind: "webEmbed", text: "Embed description", source: "https://example.com/embed", photo: { fileId: 97 },
      dimensions: { width: 560, height: 315 }, fullWidth: true, allowScrolling: true },
  ] });
  expect(JSON.stringify(article)).not.toContain(embed.html);
  const urlOnly = schemas.instantView.output.parse(readInstantView(page({ ...embed, html: "", width: 0 })));
  expect(urlOnly?.partial).toBe(false);
  expect(urlOnly?.blocks[0]).not.toHaveProperty("dimensions");
  expect(findInstantViewPhoto(page(embed), 97, selectPhoto)?.preview).toBe(96);
  expect(readInstantView(page({ ...embed, url: "javascript:void(0)", poster_photo: undefined }))?.blocks[0])
    .toMatchObject({ kind: "webEmbed", text: "Embed description", source: undefined, photo: undefined });
});

test.each(["", "https://example.com/embed"])("shows inert formatted embed HTML on request with source %s", async (source) => {
  const url = "https://example.com/article";
  const staticHtml = '<div id="untrusted" onclick="fixture()"><p>Embed <strong>fixture</strong></p>'
    + '<table><tr><th colspan="2">Cell fixture</th></tr></table><a href="https://example.com/out">Link label</a>'
    + '<script>hidden script marker</script><style>hidden style marker</style>'
    + '<img src="https://example.com/image"><iframe src="https://example.com/frame"></iframe></div>';
  const block = { "@type": "pageBlockEmbedded", url: source, html: staticHtml };
  const article = schemas.instantView.output.parse(readInstantView({
    "@type": "webPageInstantView", is_full: true, blocks: [block],
  }, url));
  expect(article).toMatchObject({ partial: true, blocks: [{ kind: "webEmbed", staticHtml }] });
  expect(readInstantView({ "@type": "webPageInstantView", is_full: true,
    blocks: [{ ...block, url: "", html: "x".repeat(32769) }] }, url)).toBeNull();

  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}><InstantViewButton url={url} /></InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const show = await screen.findByRole("button", { name: "Show embedded preview" });
    if (source) expect(screen.getByRole("link", { name: "Open embedded content" }).getAttribute("href")).toBe(source);
    expect(screen.queryByText("Cell fixture")).toBeNull();
    fireEvent.click(show);
    expect(screen.getByRole("dialog").querySelector("iframe")).toBeNull();
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Cell fixture" }).getAttribute("colspan")).toBe("2");
    expect(screen.getByText("fixture").tagName).toBe("STRONG");
    expect(screen.getByText("Link label").tagName).toBe("SPAN");
    const embed = table.closest(".mtg-instant-view-static-embed")!;
    expect(embed.querySelector("script, style, img, iframe, a, [onclick], #untrusted")).toBeNull();
    expect(within(embed as HTMLElement).queryByText(/hidden .* marker/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide embedded preview" }));
    expect(screen.queryByText("Cell fixture")).toBeNull();
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("serves only the displayed preview file for a valid related article", () => {
  const selectPhoto = (sizes: unknown) => typeof sizes === "number"
    ? { preview: sizes, large: sizes + 1, dimensions: { width: 40, height: 40 } } : undefined;
  const page = { "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockRelatedArticles", articles: [
      { "@type": "pageBlockRelatedArticle", title: "Valid", url: "https://example.com/related",
        photo: { "@type": "photo", sizes: 93 } },
      { "@type": "pageBlockRelatedArticle", title: "Invalid", url: "javascript:void(0)",
        photo: { "@type": "photo", sizes: 95 } },
    ] },
  ] };
  expect(schemas.instantView.output.parse(readInstantView(page, undefined, selectPhoto))?.blocks).toMatchObject([
    { kind: "related", articles: [{ title: "Valid", previewFileId: 93 }] },
  ]);
  expect(findInstantViewPhoto(page, 93, selectPhoto)).toEqual({ preview: 93, large: 93 });
  expect(findInstantViewPhoto(page, 94, selectPhoto)).toBeUndefined();
  expect(findInstantViewPhoto(page, 95, selectPhoto)).toBeUndefined();
});

test("uses only validated public chat links from article blocks", () => {
  const chat = (username: string) => ({ "@type": "pageBlockChatLink", title: "Fixture channel", username,
    photo: { "@type": "chatPhotoInfo", small: { "@type": "file", id: 92 } } });
  const article = readInstantView({ "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockAnchor", name: "channel" },
    chat("Fixture_Channel"), chat("proxy"), chat("p?start=fixture"), chat("https://example.com"),
  ] });
  expect(schemas.instantView.output.parse(article)).toMatchObject({
    partial: true, blocks: [{ kind: "chatLink", text: "Fixture channel", anchors: ["channel"], avatarFileId: 92, url: "https://t.me/fixture_channel" }],
  });
  expect(article?.blocks).toHaveLength(1);
});

test.each([true, false])("opens Instant View only by request and keeps the original link (available: %s)", async (available) => {
  const prototype = HTMLDialogElement.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    const url = "https://example.com/story";
    const nextUrl = "https://example.com/next";
    const load = vi.fn(async (requested: string) => requested === nextUrl ? null : available ? { rtl: false, partial: false,
      feedbackUrl: "https://t.me/previews?start=webpage123", blocks: [
      { kind: "title" as const, text: "<script>Fixture heading</script>" },
      { kind: "byline" as const, text: "Main article author", publishedAt: 1700000000 },
      { kind: "math" as const, text: String.raw`\frac{a}{b}` },
      { kind: "paragraph" as const, text: "Fixture appointment", dates: [
        { offset: 0, length: 19, unixTime: 1700000000, format: { kind: "original" as const } },
      ] },
      { kind: "paragraph" as const, text: "🧮 x^2 done", formulas: [{ offset: 3, length: 3 }],
        styles: [{ style: "bold" as const, offset: 0, length: 11 }] },
      { kind: "math" as const, text: String.raw`\href{https://example.com/fixture}{Fixture formula link}` },
      { kind: "math" as const, text: String.raw`\unknownfixturecommand` },
      { kind: "paragraph" as const, text: "Fixture link",
        styles: [{ offset: 0, length: 7, style: "bold" as const }],
        links: [{ offset: 8, length: 4, url: "https://example.com/source" }] },
      { kind: "paragraph" as const, text: "Email Phone Invalid",
        links: [
          { offset: 0, length: 5, url: "mailto:fixture@example.com" },
          { offset: 6, length: 5, url: "tel:+12025550100" },
          { offset: 12, length: 7, url: "mailto:fixture@example.com?bcc=other@example.com" },
        ] },
      { kind: "paragraph" as const, text: "Read details",
        links: [{ offset: 0, length: 12, url: url + "#details" }] },
      { kind: "paragraph" as const, text: "Jump to last slide",
        links: [{ offset: 0, length: 18, url: url + "#last-slide" }] },
      { kind: "richQuote" as const, text: "", credit: { text: "Fixture quote source" }, blocks: [
        { kind: "details" as const, text: "Outer section", open: false, blocks: [
          { kind: "details" as const, text: "Inner section", open: false, blocks: [
            { kind: "heading" as const, text: "Details", level: 4, anchors: ["details"] },
          ] },
        ] },
      ] },
      { kind: "webEmbed" as const, text: "External player description", source: "https://example.com/embed", dimensions: { width: 560, height: 315 }, allowScrolling: false },
      { kind: "photo" as const, text: "Photo caption fixture", credit: { text: "Fixture photographer" }, url: "https://example.com/photo-source",
        photo: { fileId: 72, spoiler: true, dimensions: { width: 640, height: 480 } } },
      { kind: "slideshow" as const, text: "Slideshow caption fixture", media: [
        { kind: "photo" as const, text: "Slide caption fixture", url: url + "#details",
          photo: { fileId: 82, spoiler: true, dimensions: { width: 640, height: 480 } } },
        { kind: "video" as const, text: "Video caption fixture",
          video: { fileId: 53, mime: "video/mp4" as const, spoiler: true, loop: false } },
        { kind: "video" as const, text: "Next video fixture", anchors: ["last-slide"],
          video: { fileId: 58, mime: "video/mp4" as const, spoiler: true, loop: false } },
      ] },
      { kind: "table" as const, text: "Results", bordered: true, striped: false, compact: true,
        rows: [[{ text: "Total", header: true, colSpan: 2, rowSpan: 1 }]] },
      { kind: "audio" as const, text: "Voice caption fixture",
        audio: { fileId: 54, mime: "audio/ogg" as const, voiceNote: true } },
      { kind: "video" as const, text: "Animation caption fixture",
        video: { fileId: 55, mime: "video/mp4" as const, spoiler: true, loop: true } },
      { kind: "video" as const, text: "GIF caption fixture",
        video: { fileId: 56, mime: "image/gif" as const, spoiler: true, loop: true } },
      { kind: "code" as const, text: "fn main() {\n    println!(\"fixture\");\n}", language: "rust" },
      { kind: "embeddedPost" as const, text: "Embedded post caption", author: "Embedded author", avatarFileId: 91,
        publishedAt: 1700000000, source: "https://example.com/post",
        blocks: [{ kind: "paragraph" as const, text: "Embedded post text" }] },
      { kind: "buttons" as const, text: "", align: "center" as const, buttons: [
        { kind: "url" as const, label: "Open fixture details", url: url + "#details" },
        { kind: "copy" as const, label: "Copy fixture code", text: "Fixture code" },
      ] },
      { kind: "map" as const, text: "Map fixture", point: { latitude: 5, longitude: 6, zoom: 17, dimensions: { width: 512, height: 384 } } },
      { kind: "chatLink" as const, text: "Fixture channel", avatarFileId: 92, url: "https://t.me/fixture_channel" },
      { kind: "related" as const, text: "Related reading", articles: [{ url: "https://example.com/next",
        title: "Next article", description: "A summary", author: "Fixture author", previewFileId: 93 }] },
      { kind: "list" as const, text: "", items: [{ numbering: "a" as const, value: 3, blocks: [
        { kind: "paragraph" as const, text: "Third" },
        { kind: "document" as const, text: "Article attachment caption", fileId: 51,
          document: { name: "Article.txt", downloadable: true, sizeBytes: 1024 } },
        { kind: "list" as const, text: "", items: [{ checked: true, blocks: [{ kind: "paragraph" as const, text: "Nested task" }] }] },
      ] }, { numbering: "I" as const, value: 8, blocks: [{ kind: "paragraph" as const, text: "Roman item fixture" }] },
        { blocks: [{ kind: "paragraph" as const, text: "Bullet item fixture" }] },
      ] },
    ] } : null);
    const loadPhoto = vi.fn(async () => ({ mime: "image/png" as const, base64: "AA==" }));
    const loadVideo = vi.fn(async () => "/api/v1/plugins/makosh-telegram/http/video-stream");
    const saveDocument = vi.fn(async () => true);
    const loadMap = vi.fn(async () => "AA==");
    const openTelegram = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<OpenTelegramMessageLink.Provider value={openTelegram}><InstantViewLoader.Provider value={load}><InstantViewDocumentSaver.Provider value={saveDocument}><InstantViewMapLoader.Provider value={loadMap}><InstantViewPhotoLoader.Provider value={loadPhoto}><InstantViewPlaybackLoader.Provider value={loadVideo}>
      <MessageContent chatId="42" message={{ id: "20", text: "Fixture link", author: "", time: "",
        linkPreview: { url, title: "Preview fixture", site: "", description: "", above: false, instantView: true } }} />
    </InstantViewPlaybackLoader.Provider></InstantViewPhotoLoader.Provider></InstantViewMapLoader.Provider></InstantViewDocumentSaver.Provider></InstantViewLoader.Provider></OpenTelegramMessageLink.Provider>);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const dialog = screen.getByRole("dialog", { name: "Instant View" });
    expect(within(dialog).getByRole("link", { name: "Open original" }).getAttribute("href")).toBe(url);
    if (available) {
      const heading = await within(dialog).findByRole("heading", { name: "<script>Fixture heading</script>" });
      expect(heading.querySelector("script")).toBeNull();
      expect(dialog.querySelector("math[display=block] mfrac")).toBeTruthy();
      const inlineMath = dialog.querySelector("p math msup");
      expect(inlineMath).toBeTruthy();
      expect(inlineMath?.closest("math")?.getAttribute("display")).not.toBe("block");
      expect(inlineMath?.closest("p")?.querySelectorAll(".mtg-text-bold")).toHaveLength(2);
      expect(dialog.querySelector('.mtg-instant-view-formula [href]')).toBeNull();
      expect(within(dialog).getByText("Fixture appointment").getAttribute("datetime")).toBe("2023-11-14T22:13:20.000Z");
      expect(within(dialog).getByText(String.raw`\unknownfixturecommand`).tagName).toBe("CODE");
      const fixtureLink = within(dialog).getByRole("link", { name: "link" });
      expect(fixtureLink.closest("p")?.querySelector(".mtg-text-bold")?.textContent).toBe("Fixture");
      expect(fixtureLink.getAttribute("href")).toBe("https://example.com/source");
      expect(within(dialog).getByRole("link", { name: "Email" }).getAttribute("href")).toBe("mailto:fixture@example.com");
      expect(within(dialog).getByRole("link", { name: "Phone" }).getAttribute("href")).toBe("tel:+12025550100");
      expect(within(dialog).queryByRole("link", { name: "Invalid" })).toBeNull();
      expect(within(dialog).getByText("Invalid", { exact: false })).toBeTruthy();
      const sections = ["Outer section", "Inner section"].map((title) =>
        within(dialog).getByText(title).closest("details")!);
      const quote = within(dialog).getByText("Fixture quote source").closest("blockquote");
      expect(quote?.contains(sections[0]!)).toBe(true);
      expect(sections.map(({ open }) => open)).toEqual([false, false]);
      expect(within(dialog).getByRole("link", { name: "Read details" }).getAttribute("href")).toBe(url + "#details");
      fireEvent.click(within(dialog).getByRole("link", { name: "Open fixture details" }));
      expect(sections.map(({ open }) => open)).toEqual([true, true]);
      expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Details", level: 4 }));
      expect(within(dialog).getByText("Photo caption fixture")).toBeTruthy();
      expect(within(dialog).getByText("Fixture photographer")).toBeTruthy();
      expect(within(dialog).getByText("Main article author").closest("p")?.querySelector("time")?.dateTime)
        .toBe("2023-11-14T22:13:20.000Z");
      const embed = within(dialog).getByRole("link", { name: "Open embedded content" });
      expect(embed.getAttribute("href")).toBe("https://example.com/embed");
      expect(embed.getAttribute("rel")).toBe("noopener noreferrer");
      expect(within(dialog).getByText("External player description")).toBeTruthy();
      const embedTitle = "Embedded content from example.com";
      expect(within(dialog).queryByTitle(embedTitle)).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "Load content from example.com" }));
      const frame = within(dialog).getByTitle<HTMLIFrameElement>(embedTitle);
      expect(frame.getAttribute("src")).toBe("https://example.com/embed");
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame.getAttribute("scrolling")).toBe("no");
      expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(frame.getAttribute("srcdoc")).toBeNull();
      expect(frame.style.aspectRatio).toBe("560 / 315");
      const resizeFrame = (height: unknown, source = frame.contentWindow, origin = "null") =>
        fireEvent(window, new MessageEvent("message", {
          origin, source, data: JSON.stringify({ eventType: "resize_frame", eventData: { height, width: 8000 } }),
        }));
      resizeFrame(600, window);
      resizeFrame(600, frame.contentWindow, "https://example.com");
      resizeFrame(-2);
      resizeFrame("100%");
      expect(frame.style.height).toBe("");
      resizeFrame("640px");
      expect(frame.style.height).toBe("640px");
      expect(frame.style.width).toBe("560px");
      expect(frame.style.aspectRatio).toBe("");
      resizeFrame(100_000);
      expect(frame.style.height).toBe("4096px");
      const removedFrame = frame.contentWindow;
      fireEvent.click(within(dialog).getByRole("button", { name: "Hide embedded content" }));
      expect(within(dialog).queryByTitle(embedTitle)).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "Load content from example.com" }));
      const reopenedFrame = within(dialog).getByTitle<HTMLIFrameElement>(embedTitle);
      resizeFrame(700, removedFrame);
      expect(reopenedFrame.style.height).toBe("");
      expect(reopenedFrame.style.aspectRatio).toBe("560 / 315");
      fireEvent.click(within(dialog).getByRole("button", { name: "Hide embedded content" }));
      const linkedPhoto = within(dialog).getByText("Photo caption fixture").closest("figure")!;
      expect(within(linkedPhoto).queryByRole("link", { name: "Open photo link" })).toBeNull();
      expect(loadPhoto).not.toHaveBeenCalledWith(url, 72, undefined);
      fireEvent.click(within(linkedPhoto).getByRole("button", { name: "Show photo spoiler" }));
      const photoLink = await within(linkedPhoto).findByRole("link", { name: "Open photo link" });
      expect(photoLink.getAttribute("href")).toBe("https://example.com/photo-source");
      expect(photoLink.getAttribute("rel")).toBe("noopener noreferrer");
      expect(within(photoLink).getByRole("img")).toBeTruthy();
      fireEvent.click(within(linkedPhoto).getByRole("button", { name: "Enlarge Telegram photo" }));
      const enlarged = within(linkedPhoto).getByRole<HTMLDialogElement>("dialog", { name: "Telegram photo viewer" });
      expect(enlarged.open).toBe(true);
      enlarged.open = false;
      fireEvent(enlarged, new Event("close"));
      expect(dialog.isConnected && dialog.hasAttribute("open")).toBe(true);
      await waitFor(() => {
        expect(loadPhoto).toHaveBeenCalledWith(url, 91);
        expect(loadPhoto).toHaveBeenCalledWith(url, 92);
        expect(loadPhoto).toHaveBeenCalledWith(url, 93);
      });
      expect(loadPhoto).not.toHaveBeenCalledWith(url, 82, undefined);
      const gallery = within(dialog).getByRole("list", { name: "Article slides" });
      expect(within(gallery).getByText("Slide caption fixture")).toBeTruthy();
      expect(within(dialog).getByText("Slideshow caption fixture")).toBeTruthy();
      const table = within(dialog).getByRole("table", { name: "Results" });
      expect(within(table).getByRole("columnheader", { name: "Total" }).getAttribute("colspan")).toBe("2");
      expect(within(dialog).getByRole("link", { name: "Next article" }).getAttribute("href")).toBe("https://example.com/next");
      expect(within(dialog).getByText("A summary")).toBeTruthy();
      const listItem = within(dialog).getByText("Third").closest("li")!;
      expect(listItem.getAttribute("value")).toBe("3");
      expect(listItem.dataset.numbering).toBe("a");
      const romanItem = within(dialog).getByText("Roman item fixture").closest("li")!;
      expect(romanItem.parentElement).toBe(listItem.parentElement);
      expect(romanItem.dataset.numbering).toBe("I");
      expect(romanItem.value).toBe(8);
      expect(within(dialog).getByText("Bullet item fixture").closest("li")?.dataset.numbering).toBe("bullet");
      const nested = within(listItem).getByRole("list");
      const task = within(nested).getByRole<HTMLInputElement>("checkbox", { name: "Task status" });
      expect(task.checked && task.disabled).toBe(true);
      fireEvent.click(within(gallery).getByRole("button", { name: "Show photo spoiler" }));
      const slideLink = await within(gallery).findByRole("link", { name: "Open photo link" });
      expect(fireEvent.click(within(slideLink).getByRole("img"))).toBe(false);
      expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Details", level: 4 }));
      expect(loadPhoto).toHaveBeenCalledWith(url, 82, undefined);
      const nextSlide = within(dialog).getByRole("button", { name: "Next slide" });
      expect(within(dialog).getByRole("button", { name: "Previous slide" }).getAttribute("aria-disabled")).toBe("true");
      expect(within(gallery).queryByText("Video caption fixture")).toBeNull();
      const jumpToLast = within(dialog).getByRole("link", { name: "Jump to last slide" });
      fireEvent.click(jumpToLast);
      expect(document.activeElement?.textContent).toContain("Next video fixture");
      expect(loadVideo).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Back to previous section" }));
      expect(within(gallery).getByText("Slide caption fixture")).toBeTruthy();
      expect(document.activeElement).toBe(jumpToLast);
      fireEvent.click(jumpToLast);
      fireEvent.keyDown(nextSlide, { key: "Home" });
      fireEvent.keyDown(nextSlide, { key: "End" });
      expect(within(gallery).getByText("Next video fixture")).toBeTruthy();
      fireEvent.keyDown(nextSlide, { key: "Home" });
      expect(within(gallery).getByText("Slide caption fixture")).toBeTruthy();
      fireEvent.keyDown(nextSlide, { key: "ArrowRight" });
      expect(within(gallery).getByText("Video caption fixture")).toBeTruthy();
      expect(within(gallery).queryByText("Slide caption fixture")).toBeNull();
      expect(nextSlide.getAttribute("aria-disabled")).toBe("false");
      expect(within(gallery).queryByRole("button", { name: "Load video player" })).toBeNull();
      fireEvent.click(within(gallery).getByRole("button", { name: "Show video spoiler" }));
      expect(loadVideo).not.toHaveBeenCalled();
      fireEvent.click(within(gallery).getByRole("button", { name: "Load video player" }));
      await within(gallery).findByText("Playback speed");
      expect(loadVideo).toHaveBeenCalledExactlyOnceWith(url, 53);
      fireEvent.click(nextSlide);
      expect(within(gallery).getByText("Next video fixture")).toBeTruthy();
      expect(nextSlide.getAttribute("aria-disabled")).toBe("true");
      expect(within(gallery).queryByRole("button", { name: "Load video player" })).toBeNull();
      expect(within(gallery).getByRole("button", { name: "Show video spoiler" })).toBeTruthy();
      expect(gallery.querySelector("video")).toBeNull();
      expect(loadVideo).toHaveBeenCalledExactlyOnceWith(url, 53);
      fireEvent.click(within(dialog).getByRole("button", { name: "Load audio player" }));
      await within(dialog).findByText("Voice caption fixture");
      expect(loadVideo.mock.calls).toEqual([[url, 53], [url, 54]]);
      const animation = within(dialog).getByText("Animation caption fixture").closest("figure")!;
      fireEvent.click(within(animation).getByRole("button", { name: "Show video spoiler" }));
      expect(loadVideo).toHaveBeenCalledTimes(2);
      fireEvent.click(within(animation).getByRole("button", { name: "Load video player" }));
      await within(animation).findByRole("button", { name: "Close player" });
      expect(animation.querySelector("video")?.loop).toBe(true);
      expect(loadVideo.mock.calls).toEqual([[url, 53], [url, 54], [url, 55]]);
      const gif = within(dialog).getByText("GIF caption fixture").closest("figure")!;
      fireEvent.click(within(gif).getByRole("button", { name: "Show GIF spoiler" }));
      expect(loadVideo).toHaveBeenCalledTimes(3);
      fireEvent.click(within(gif).getByRole("button", { name: "View image" }));
      expect((await within(gif).findByRole("img", { name: "Telegram image" })).getAttribute("src"))
        .toBe("/api/v1/plugins/makosh-telegram/http/video-stream");
      expect(loadVideo).toHaveBeenLastCalledWith(url, 56);
      const related = within(dialog).getByRole("link", { name: "Next article" });
      dialog.scrollTop = 260;
      fireEvent.click(related);
      await within(dialog).findByText("Instant View is unavailable for this link.");
      expect(dialog.scrollTop).toBe(0);
      expect(within(dialog).getByRole("link", { name: "Open original" }).getAttribute("href")).toBe(nextUrl);
      fireEvent.click(within(dialog).getByRole("button", { name: "Back to article" }));
      expect(dialog.scrollTop).toBe(260);
      expect(["Outer section", "Inner section"].map((title) =>
        within(dialog).getByText(title).closest("details")?.open)).toEqual([true, true]);
      expect(document.activeElement).toBe(within(dialog).getByRole("link", { name: "Next article" }));
      expect(within(within(dialog).getByRole("list", { name: "Article slides" })).getByText("Next video fixture")).toBeTruthy();
      expect(load.mock.calls).toEqual([[url], [nextUrl]]);
      const post = within(dialog).getByText("Embedded post caption").closest("figure")!;
      expect(within(post).getByText("Embedded author")).toBeTruthy();
      expect(within(post).getByText("Embedded post text")).toBeTruthy();
      expect(post.querySelector("time")?.dateTime).toBe(new Date(1700000000 * 1000).toISOString());
      expect(within(post).getByRole("link", { name: "Open original post" }).getAttribute("href")).toBe("https://example.com/post");
      const clipboard = vi.fn(async (_text: string) => {});
      const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
      try {
        fireEvent.click(within(dialog).getByRole("button", { name: "Copy fixture code" }));
        await within(dialog).findByText("Copied.");
        expect(clipboard).toHaveBeenCalledExactlyOnceWith("Fixture code");
        const code = within(dialog).getByText("rust").closest(".mtg-instant-view-code") as HTMLElement;
        expect(code.querySelector("pre code")?.textContent).toBe("fn main() {\n    println!(\"fixture\");\n}");
        fireEvent.click(within(code).getByRole("button", { name: "Copy code" }));
        await within(code).findByText("Copied.");
        expect(clipboard).toHaveBeenLastCalledWith("fn main() {\n    println!(\"fixture\");\n}");
      } finally {
        if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
        else Reflect.deleteProperty(navigator, "clipboard");
      }
      expect(saveDocument).not.toHaveBeenCalled();
      const currentListItem = within(dialog).getByText("Third").closest("li")!;
      fireEvent.click(within(currentListItem).getByRole("button", { name: "Download Article.txt" }));
      await vi.waitFor(() => expect(saveDocument).toHaveBeenCalledExactlyOnceWith(url, 51));
      const map = within(dialog).getByText("Map fixture").closest("figure")!;
      expect(loadMap).not.toHaveBeenCalled();
      const mapLink = within(map).getByRole("link", { name: "Open map" });
      expect(mapLink.getAttribute("href")).toContain("#map=17/5/6");
      fireEvent.click(within(map).getByRole("button", { name: "Show map preview" }));
      const preview = await within(map).findByRole("img");
      expect(preview.getAttribute("width")).toBe("512");
      expect(preview.getAttribute("height")).toBe("384");
      expect(loadMap).toHaveBeenCalledExactlyOnceWith(url, { latitude: 5, longitude: 6, zoom: 17, dimensions: { width: 512, height: 384 } });
      const feedbackLink = within(dialog).getByRole("link", { name: "Give Instant View feedback" });
      expect(feedbackLink.getAttribute("href")).toBe("https://t.me/previews?start=webpage123");
      expect(openTelegram).not.toHaveBeenCalled();
      fireEvent.click(feedbackLink);
      await vi.waitFor(() => expect(within(feedbackLink.parentElement!).getByText("Telegram link unavailable.")).toBeTruthy());
      expect(openTelegram).toHaveBeenLastCalledWith("https://t.me/previews?start=webpage123", expect.any(AbortSignal));
      const channel = within(dialog).getByRole("link", { name: "Fixture channel @fixture_channel" });
      expect(channel.getAttribute("href")).toBe("https://t.me/fixture_channel");
      fireEvent.click(channel);
      await within(channel.parentElement!).findByText("Telegram link unavailable.");
      fireEvent.click(channel);
      await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Instant View" })).toBeNull());
      expect(openTelegram).toHaveBeenCalledTimes(3);
      expect(openTelegram).toHaveBeenLastCalledWith("https://t.me/fixture_channel", expect.any(AbortSignal));
    } else {
      await within(dialog).findByText("Instant View is unavailable for this link.");
      expect(load).toHaveBeenCalledExactlyOnceWith(url);
    }
  } finally {
    if (original) Object.defineProperty(prototype, "showModal", original);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("offers the original file beside article playback, including inside a collage", async () => {
  const video = (id: number, has_spoiler = false) => ({ "@type": "pageBlockVideo", has_spoiler,
    video: { "@type": "video", mime_type: "video/mp4", duration: 70, video: { "@type": "file", id, size: 300 } } });
  const page = { "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockCollage", blocks: [video(62), {
      "@type": "pageBlockAudio", audio: { "@type": "audio", mime_type: "audio/mpeg", file_name: "Fixture.mp3",
        audio: { "@type": "file", id: 63, size: 200 } },
    }, {
      "@type": "pageBlockVoiceNote", voice_note: { mime_type: "audio/ogg", duration: 12, waveform: "HwA=",
        voice: { "@type": "file", id: 65, size: 200 } },
    }] }, video(64, true),
  ] };
  const article = schemas.instantView.output.parse(readInstantView(page));
  const url = "https://example.com/article";
  const save = vi.fn(async () => true);
  const playback = vi.fn(async () => "/fixture/stream");
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  try {
    render(<InstantViewLoader.Provider value={async () => article}>
      <InstantViewDocumentSaver.Provider value={save}><InstantViewPlaybackLoader.Provider value={playback}>
        <InstantViewButton url={url} />
      </InstantViewPlaybackLoader.Provider></InstantViewDocumentSaver.Provider>
    </InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const videoDownload = await screen.findByRole("button", { name: "Download Telegram media.mp4" });
    expect(screen.getByRole("button", { name: "Load video player", description: "Duration 1:10" })).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(videoDownload);
    fireEvent.click(screen.getByRole("button", { name: "Download Fixture.mp3" }));
    await waitFor(() => expect(save.mock.calls).toEqual([[url, 62], [url, 63]]));
    expect(playback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show video spoiler" }));
    expect(screen.getAllByRole("button", { name: "Download Telegram media.mp4" })).toHaveLength(1);
    expect(findInstantViewDocument(page, 64)).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Load audio player", description: "Duration 0:12" }));
    const audio = await screen.findByLabelText<HTMLAudioElement>("Telegram audio");
    expect(playback).toHaveBeenCalledExactlyOnceWith(url, 65);
    expect(fireEvent.keyDown(audio, { key: "s", code: "KeyS", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(url, 65));
    const slider = screen.getByRole("slider", { name: "Voice note position" });
    Object.defineProperty(audio, "duration", { value: 12 });
    fireEvent.loadedMetadata(audio);
    fireEvent.input(slider, { target: { value: "6" } });
    expect(audio.currentTime).toBe(6);
    expect(slider.closest(".mtg-playback-waveform")?.querySelectorAll(".mtg-waveform-bars > span")).toHaveLength(3);
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});

test("keeps unplayable article media downloadable, including inside a gallery", async () => {
  const video = { "@type": "pageBlockVideo", video: { mime_type: "video/quicktime", file_name: "Clip.mov",
    video: { "@type": "file", id: 62, size: 0, expected_size: 211 } },
    caption: { text: { "@type": "richTextPlain", text: "Clip caption" } } };
  const page = { "@type": "webPageInstantView", is_full: true, blocks: [
    { "@type": "pageBlockCollage", blocks: [video, { "@type": "pageBlockPhoto", photo: null, url: "https://example.com/image-source",
      caption: { credit: { "@type": "richTextPlain", text: "Missing photo credit" } } }] },
    { ...video, has_spoiler: true, video: { ...video.video, video: { id: 63, size: 211 } } },
    { "@type": "pageBlockPhoto", photo: null, url: "https://example.com/cover-source", caption: null },
    { "@type": "pageBlockPhoto", photo: null, url: "javascript:alert(1)", caption: null },
  ] };
  const document = { name: "Clip.mov", downloadable: true, sizeBytes: 211, approximateSize: true };
  const article = schemas.instantView.output.parse(readInstantView(page));
  expect(article).toMatchObject({ partial: true, blocks: [
    { kind: "collage", media: [{ kind: "document", fileId: 62, text: "Clip caption", document },
      { kind: "missingMedia", credit: { text: "Missing photo credit" }, url: "https://example.com/image-source" }] },
    { kind: "missingMedia", text: "Clip caption" },
    { kind: "missingMedia", text: "", url: "https://example.com/cover-source" },
  ] });
  expect(findInstantViewPlayback(page, 62)).toBeUndefined();
  expect(findInstantViewDocument(page, 62)).toEqual({ fileId: 62, document });
  expect(findInstantViewDocument(page, 63)).toBeUndefined();

  const url = "https://example.com/article";
  const save = vi.fn(async () => true);
  const prototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
  Object.defineProperty(prototype, "showModal", {
    configurable: true, value: function (this: HTMLDialogElement) { this.open = true; },
  });
  try {
    render(<InstantViewLoader.Provider value={async () => article}>
      <InstantViewDocumentSaver.Provider value={save}>
        <InstantViewButton url={url} />
      </InstantViewDocumentSaver.Provider>
    </InstantViewLoader.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Instant View" }));
    const download = await screen.findByRole("button", { name: "Download Clip.mov" });
    expect(screen.getAllByText("Media unavailable")).toHaveLength(3);
    expect(screen.getAllByRole("link", { name: "Open photo link" }).map((link) => link.getAttribute("href")))
      .toEqual(["https://example.com/image-source", "https://example.com/cover-source"]);
    expect(screen.getByText("Missing photo credit")).toBeTruthy();
    expect(screen.getAllByText("Clip caption")).toHaveLength(2);
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(download);
    await waitFor(() => expect(save).toHaveBeenCalledWith(url, 62));
  } finally {
    if (showModal) Object.defineProperty(prototype, "showModal", showModal);
    else Reflect.deleteProperty(prototype, "showModal");
  }
});
