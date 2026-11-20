import { documentName } from "./document-name.ts";
import { decodeVoiceWaveform } from "./voice-waveform.ts";
import { articleMapPoint, type ArticleMapPoint, type ArticleButton, customEmojiId, type CustomEmojiRange, maxDocumentBytes, maxInstantViewBlocks, maxPhotoEdge, maxPlaybackBytes, type InstantViewArticle, type InstantViewFormulaRange, type InstantViewDateRange, type InstantViewIconRange, instantViewIconMime, maxPhotoBytes, readAudioPlaybackMime, type InstantViewList, type RichStyledRange } from "../../core/contract.ts";
import { articleContactLink, webLink, type MessageLink } from "../../core/message-links.ts";
import { canonicalTelegramContentLink } from "../../core/telegram-content-link.ts";
import { canonicalTelegramBotStartLink, canonicalTelegramMessageLink, canonicalTelegramPublicChatLink } from "../../core/public-chat-reference.ts";
import { maskSpoilers } from "../../core/message-spoilers.ts";

export function instantViewPageUrl(value: string) {
  const url = webLink(value);
  if (!url || url.href.length > 4096) return;
  return url.href.split("#", 1)[0];
}

function articleWebLink(value: string): URL | undefined {
  const direct = webLink(value);
  if (direct) return direct;
  const telegram = canonicalTelegramContentLink(value);
  if (telegram) return webLink(telegram);
}

const inlineStyles = new Map<string, RichStyledRange["style"]>([
  ["richTextBold", "bold"], ["richTextItalic", "italic"], ["richTextUnderline", "underline"],
  ["richTextStrikethrough", "strike"], ["richTextSpoiler", "spoiler"], ["richTextFixed", "code"],
  ["richTextMarked", "marked"], ["richTextSubscript", "subscript"], ["richTextSuperscript", "superscript"],
]);

const blockKinds = new Map<string, "title" | "subtitle" | "kicker" | "footer" | "heading" | "paragraph" | "quote" | "code">([
  ["pageBlockTitle", "title"], ["pageBlockSubtitle", "subtitle"], ["pageBlockHeader", "heading"],
  ["pageBlockSubheader", "heading"], ["pageBlockKicker", "kicker"], ["pageBlockAuthorDate", "paragraph"],
  ["pageBlockSectionHeading", "heading"],
  ["pageBlockParagraph", "paragraph"], ["pageBlockFooter", "footer"], ["pageBlockBlockQuote", "quote"],
  ["pageBlockPullQuote", "quote"], ["pageBlockPreformatted", "code"],
]);
const emptyText = { "@type": "richTextPlain", text: "" };

function blockTextSource(block: Record<string, unknown>) {
  switch (block["@type"]) {
    case "pageBlockTitle": return block.title ?? block.text;
    case "pageBlockSubtitle": return block.subtitle ?? block.text;
    case "pageBlockHeader": return block.header ?? block.text;
    case "pageBlockSubheader": return block.subheader ?? block.text;
    case "pageBlockKicker": return block.kicker ?? block.text;
    case "pageBlockAuthorDate": return block.author;
    case "pageBlockFooter": return block.footer ?? block.text;
    default: return block.text;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function validAnchor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function articleDateFormat(value: unknown): InstantViewDateRange["format"] | undefined {
  if (value == null) return { kind: "original" };
  const format = object(value);
  if (format?.["@type"] === "dateTimeFormattingTypeRelative") return { kind: "relative" };
  if (format?.["@type"] !== "dateTimeFormattingTypeAbsolute") return;
  const readPrecision = (part: unknown) => {
    switch (object(part)?.["@type"]) {
      case "dateTimePartPrecisionNone": return "none";
      case "dateTimePartPrecisionShort": return "short";
      case "dateTimePartPrecisionLong": return "long";
    }
  };
  const date = readPrecision(format.date_precision);
  const time = readPrecision(format.time_precision);
  if (date && time && typeof format.show_day_of_week === "boolean") return { kind: "absolute", date, time, weekday: format.show_day_of_week };
}

function inlineIcon(node: Record<string, unknown>, offset: number): InstantViewIconRange | undefined {
  const document = object(node.document);
  const file = object(document?.document);
  const mime = instantViewIconMime.safeParse(document?.mime_type);
  const fileId = file?.id;
  const size = file?.size;
  if (!mime.success
    || typeof fileId !== "number" || !Number.isSafeInteger(fileId) || fileId <= 0
    || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > maxPhotoBytes) return;
  const dimension = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maxPhotoEdge ? value : 0;
  return { offset, fileId, mime: mime.data, width: dimension(node.width), height: dimension(node.height) };
}

type RecordArticleChange = (original: unknown, current: unknown) => void;

function changeExcerpt(value: unknown) {
  const chunks: string[] = [];
  let remaining = 1024;
  let visited = 0;
  let truncated = false;
  function visit(value: unknown, depth: number) {
    if (depth > 24 || ++visited > 2048 || remaining === 0) {
      truncated = true;
      return;
    }
    const node = object(value);
    if (!node) return;
    if (node["@type"] === "richTexts" && Array.isArray(node.texts)) {
      for (const child of node.texts) {
        visit(child, depth + 1);
        if (truncated) break;
      }
      return;
    }
    const text = node["@type"] === "richTextSpoiler" ? "[Spoiler]"
      : node["@type"] === "richTextMathematicalExpression" ? node.expression
      : node["@type"] === "richTextCustomEmoji" ? node.alternative_text
      : node["@type"] === "richTextIcon" ? "[Image]"
      : node["@type"] === "richTextButton" ? object(node.button)?.text
      : node.text;
    if (typeof text === "string") {
      const chunk = text.slice(0, remaining);
      chunks.push(chunk);
      remaining -= chunk.length;
      truncated ||= chunk.length < text.length;
    } else if (object(text)) visit(text, depth + 1);
  }
  visit(value, 0);
  const text = chunks.join("");
  return truncated ? text.slice(0, 1023).replace(/[\uD800-\uDBFF]$/, "") + "…" : text;
}

function readText(value: unknown, pageUrl?: string, recordChange?: RecordArticleChange) {
  const chunks: string[] = [];
  const styles: RichStyledRange[] = [];
  const links: MessageLink[] = [];
  const formulas: InstantViewFormulaRange[] = [];
  const dates: InstantViewDateRange[] = [];
  const icons: InstantViewIconRange[] = [];
  const inlineButtons: { offset: number; length: number; button: ArticleButton }[] = [];
  const tags: { offset: number; length: number; tag: string }[] = [];
  const mentions: { offset: number; length: number; userId: number }[] = [];
  const customEmoji: CustomEmojiRange[] = [];
  const anchors: string[] = [];
  let remaining = 8192;
  let visited = 0;
  let partial = false;
  function visit(value: unknown, depth: number, compare: boolean) {
    if (depth > 24 || ++visited > 2048 || remaining === 0) {
      partial = true;
      return;
    }
    const node = object(value);
    if (!node) { partial = true; return; }
    // Older TDLib uses richTextReference for the link, while current versions use it for the target.
    const legacyReference = node["@type"] === "richTextReference" && !("name" in node);
    if (node["@type"] === "richTexts" && Array.isArray(node.texts)) {
      for (const child of node.texts) {
        if (visited >= 2048 || remaining === 0) { partial = true; break; }
        visit(child, depth + 1, compare);
      }
    } else if (node["@type"] === "richTextDiff") {
      if (compare) recordChange?.(node.old_text, node.text);
      visit(node.text ?? emptyText, depth + 1, false);
    } else if ((node["@type"] === "richTextPlain" && typeof node.text === "string")
      || (node["@type"] === "richTextMathematicalExpression" && typeof node.expression === "string")
      || (node["@type"] === "richTextCustomEmoji" && typeof node.alternative_text === "string")) {
      const expression = node["@type"] === "richTextMathematicalExpression";
      const emoji = node["@type"] === "richTextCustomEmoji";
      const value = String(expression ? node.expression : emoji ? node.alternative_text : node.text);
      const chunk = value.slice(0, remaining);
      if (value.length > remaining) partial = true;
      if (expression && value.trim()) {
        if (chunk.length === value.length && chunk.length <= 4096 && formulas.length < 32) {
          formulas.push({ offset: 8192 - remaining, length: chunk.length });
        } else partial = true;
      }
      if (emoji) {
        const id = customEmojiId.safeParse(node.custom_emoji_id);
        if (id.success && chunk.length > 0 && chunk.length === value.length && customEmoji.length < 128) {
          customEmoji.push({ id: id.data, offset: 8192 - remaining, length: chunk.length });
        } else partial = true;
      }
      chunks.push(chunk);
      remaining -= chunk.length;
    } else if (node["@type"] === "richTextButton") {
      const button = object(node.button);
      const offset = 8192 - remaining;
      const count = inlineButtons.length;
      visit(button?.text, depth + 1, compare);
      const length = 8192 - remaining - offset;
      const label = chunks.join("").slice(offset, offset + length);
      const action = label.length <= 256 ? articleButtonAction(button, label) : undefined;
      if (action && length && inlineButtons.length === count && count < 32) inlineButtons.push({ offset, length, button: action });
      else partial = true;
    } else if (node["@type"] === "richTextIcon") {
      const icon = icons.length < 32 ? inlineIcon(node, 8192 - remaining) : undefined;
      if (icon) {
        icons.push(icon);
        chunks.push("\ufffc");
        remaining--;
      } else partial = true;
    } else if (node["@type"] === "richTextAnchor" && validAnchor(node.name) && node.name && anchors.length < 32) {
      anchors.push(node.name);
    } else if (object(node.text)) {
      const offset = 8192 - remaining;
      visit(node.text, depth + 1, compare && node["@type"] !== "richTextSpoiler");
      const length = 8192 - remaining - offset;
      if (!length) return;
      // Web articles have no session-window target for these contextual entities.
      if (node["@type"] === "richTextBankCardNumber" || node["@type"] === "richTextTonAddress"
        || node["@type"] === "richTextBotCommand") return;
      const style = typeof node["@type"] === "string" ? inlineStyles.get(node["@type"]) : undefined;
      if (style && styles.length < 128) styles.push({ offset, length, style });
      else if (node["@type"] === "richTextDateTime") {
        const format = articleDateFormat(node.formatting_type);
        const unixTime = node.unix_time;
        if (format && typeof unixTime === "number" && Number.isInteger(unixTime) && unixTime >= -2147483648
          && unixTime <= 2147483647 && length <= 4096 && dates.length < 32) {
          dates.push({ offset, length, unixTime, format });
        } else partial = true;
      } else if (node["@type"] === "richTextReference" && validAnchor(node.name) && node.name && anchors.length < 32) {
        anchors.push(node.name);
      } else if (node["@type"] === "richTextMention") {
        const url = typeof node.username === "string" && node.username.length <= 65
          ? canonicalTelegramPublicChatLink("@" + node.username.replace(/^@/, "")) : undefined;
        if (url && links.length < 64) links.push({ offset, length, url });
        else partial = true;
      } else if (node["@type"] === "richTextMentionName") {
        const userId = node.user_id;
        if (typeof userId === "number" && Number.isSafeInteger(userId) && userId > 0 && length <= 4096 && mentions.length < 64) {
          mentions.push({ offset, length, userId });
        } else partial = true;
      } else if (node["@type"] === "richTextHashtag" || node["@type"] === "richTextCashtag") {
        const hashtag = node["@type"] === "richTextHashtag";
        const value = hashtag ? node.hashtag : node.cashtag;
        const prefix = hashtag ? "#" : "$";
        const tag = typeof value === "string" ? value.startsWith(prefix) ? value : prefix + value : "";
        if (tag.length <= 128 && length <= 4096 && /^[#$][\p{L}\p{N}_]+$/u.test(tag) && tags.length < 64) tags.push({ offset, length, tag });
        else partial = true;
      } else if (node["@type"] === "richTextEmailAddress" || node["@type"] === "richTextPhoneNumber") {
        const email = node["@type"] === "richTextEmailAddress";
        const contact = email ? node.email_address : node.phone_number;
        const url = typeof contact === "string" && contact.length <= 254
          ? articleContactLink(email ? "mailto:" + contact : "tel:" + contact.replace(/[ ().-]/g, "")) : undefined;
        if (url && links.length < 64) links.push({ offset, length, url: url.href });
        else partial = true;
      } else if (node["@type"] === "richTextUrl" || node["@type"] === "richTextAnchorLink"
        || node["@type"] === "richTextReferenceLink" || legacyReference) {
        const url = typeof node.url === "string" ? articleWebLink(node.url) : undefined;
        const destination = node["@type"] === "richTextReferenceLink" ? node.reference_name : node.anchor_name;
        const name = node["@type"] !== "richTextUrl" && validAnchor(destination)
          && (destination || node["@type"] === "richTextAnchorLink") ? destination : undefined;
        const local = name !== undefined && pageUrl ? new URL(pageUrl) : undefined;
        if (local && name !== undefined) local.hash = "#" + name.replaceAll("%", "%25");
        const href = (local ?? url)?.href;
        if (href && href.length <= 4096 && links.length < 64) links.push({ offset, length, url: href,
          ...(node["@type"] === "richTextUrl" && node.is_cached === true && { instantView: true as const }) });
        else partial = true;
      } else partial = true;
    } else {
      partial = true;
    }
  }
  visit(value, 0, true);
  return { partial, anchors, text: chunks.join(""),
    ...(styles.length ? { styles } : {}),
    ...(formulas.length ? { formulas } : {}),
    ...(dates.length ? { dates } : {}),
    ...(icons.length ? { icons } : {}),
    ...(inlineButtons.length ? { inlineButtons } : {}),
    ...(tags.length ? { tags } : {}),
    ...(mentions.length ? { mentions } : {}),
    ...(customEmoji.length ? { customEmoji } : {}),
    ...(links.length ? { links: links.sort((a, b) => a.offset - b.offset) } : {}),
  };
}

type PhotoVariants = {
  preview: number;
  large: number;
  dimensions: { width: number; height: number };
  largeDimensions?: { width: number; height: number };
};
type SelectPhoto = (sizes: unknown) => PhotoVariants | undefined;

function instantViewPhotoVariants(blockValue: unknown, selectPhoto: SelectPhoto) {
  const block = object(blockValue);
  if (block?.["@type"] === "pageBlockPhoto") return selectPhoto(object(block.photo)?.sizes);
  if (block?.["@type"] === "pageBlockEmbedded") return selectPhoto(object(block.poster_photo)?.sizes);
}

function articleAvatarFileId(block: Record<string, unknown>, selectPhoto?: SelectPhoto): number | undefined {
  if (block["@type"] === "pageBlockEmbeddedPost") return selectPhoto?.(object(block.author_photo)?.sizes)?.preview;
  if (block["@type"] !== "pageBlockChatLink" || typeof block.username !== "string"
    || !canonicalTelegramPublicChatLink(`@${block.username}`)) return;
  const photo = object(block.photo);
  const id = object(photo?.small)?.id;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
}

function articleBlock(value: unknown) {
  const block = object(value);
  return block?.["@type"] === "pageBlockCover" ? object(block.cover) : block;
}

const playableFields = new Map([
  ["pageBlockVideo", ["video", "video"]],
  ["pageBlockAnimation", ["animation", "animation"]],
  ["pageBlockAudio", ["audio", "audio"]],
  ["pageBlockVoiceNote", ["voice_note", "voice"]],
] as const);

function articleMediaFile(block: Record<string, unknown> | undefined) {
  const type = block?.["@type"];
  if (type !== "pageBlockVideo" && type !== "pageBlockAnimation" && type !== "pageBlockAudio" && type !== "pageBlockVoiceNote") return;
  const fields = playableFields.get(type)!;
  const media = object(block?.[fields[0]]);
  return { type, media, file: object(media?.[fields[1]]) };
}

function mediaReference(block: Record<string, unknown> | undefined) {
  const source = articleMediaFile(block);
  if (!source) return;
  const { type, media, file } = source;
  const mime = media?.mime_type;
  const reportedSize = file?.size;
  const id = file?.id;
  if (typeof reportedSize !== "number" || !Number.isSafeInteger(reportedSize) || reportedSize < 0 || reportedSize > maxDocumentBytes
    || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return;
  const expectedSize = file?.expected_size;
  const size = reportedSize || undefined;
  const sizeInfo = { size, ...(!size && typeof expectedSize === "number"
    && Number.isSafeInteger(expectedSize) && expectedSize > 0 && { expectedSize }) };
  if (type === "pageBlockVideo" && (mime === "video/mp4" || mime === "video/webm")) return { kind: "video", id, ...sizeInfo, mime } as const;
  if (type === "pageBlockAnimation" && (mime === "video/mp4" || (mime === "image/gif" && reportedSize <= maxPlaybackBytes))) {
    return { kind: "video", id, ...sizeInfo, mime } as const;
  }
  if (type === "pageBlockAudio" || type === "pageBlockVoiceNote") {
    const audioMime = readAudioPlaybackMime(mime);
    if (audioMime) return { kind: "audio", id, ...sizeInfo, mime: audioMime } as const;
  }
}

function galleryKind(block: Record<string, unknown>) {
  if (block["@type"] === "pageBlockCollage") return "collage";
  if (block["@type"] === "pageBlockSlideshow") return "slideshow";
}

// TDLib releases use different JSON field names for these block arrays.
function pageBlocks(value: Record<string, unknown> | undefined): unknown[] | undefined {
  if (Array.isArray(value?.blocks)) return value.blocks;
  if (Array.isArray(value?.page_blocks)) return value.page_blocks;
}

function galleryChildren(block: Record<string, unknown>, budget: ArticleBudget) {
  const children = pageBlocks(block);
  if (children) return takeArticleBlocks(children, budget);
  budget.partial = true;
  return [];
}

function articlePhotoDestination(block: Record<string, unknown>) {
  if (block["@type"] !== "pageBlockPhoto") return;
  const url = typeof block.url === "string" ? articleWebLink(block.url)?.href : undefined;
  return url && url.length <= 4096 ? url : undefined;
}

function photoView(block: Record<string, unknown>, variants: PhotoVariants) {
  const url = articlePhotoDestination(block);
  const fullWidth = variants.largeDimensions?.width;
  return {
    photo: { fileId: variants.large, dimensions: variants.dimensions, spoiler: block.has_spoiler === true,
      ...(variants.large !== variants.preview && fullWidth && fullWidth > variants.dimensions.width && { fullWidth }) },
    ...(url && { url }),
  };
}

function articleMediaDuration(media: Record<string, unknown> | undefined) {
  const duration = media?.duration;
  if (typeof duration === "number" && Number.isInteger(duration) && duration > 0 && duration <= 2147483647) return duration;
}

function videoView(block: Record<string, unknown>, reference: Extract<ReturnType<typeof mediaReference>, { kind: "video" }>) {
  const posterFileId = videoPosterFileId(block);
  const document = articleDocument(block)?.document;
  const media = articleMediaFile(block)?.media;
  const durationSeconds = articleMediaDuration(media);
  const { width, height } = media ?? {};
  const validEdge = (edge: unknown): edge is number => typeof edge === "number" && Number.isInteger(edge) && edge > 0 && edge <= 16384;
  const dimensions = validEdge(width) && validEdge(height) ? { width, height } : undefined;
  return { fileId: reference.id, mime: reference.mime, spoiler: block.has_spoiler === true,
    loop: block["@type"] === "pageBlockAnimation" || block.is_looped === true,
    ...(posterFileId !== undefined && { posterFileId }),
    ...(dimensions && { dimensions }),
    ...(durationSeconds !== undefined && { durationSeconds }),
    ...(document?.downloadable && { document }),
    ...(reference.size && block.need_autoplay === true && { autoplay: true as const }) };
}

function videoPosterFileId(block: Record<string, unknown> | undefined): number | undefined {
  if (mediaReference(block)?.kind !== "video") return;
  const thumbnail = object(articleMediaFile(block)?.media?.thumbnail);
  return articleThumbnailFileId(thumbnail);
}

function articleThumbnailFileId(thumbnail: Record<string, unknown> | undefined): number | undefined {
  const format = object(thumbnail?.format)?.["@type"];
  if (format !== "thumbnailFormatJpeg" && format !== "thumbnailFormatPng" && format !== "thumbnailFormatWebp") return;
  const file = object(thumbnail?.file);
  const id = file?.id;
  if (file?.["@type"] === "file" && typeof id === "number" && Number.isSafeInteger(id) && id > 0
    && [file.size, file.expected_size].every((size) => size === undefined
      || (typeof size === "number" && Number.isSafeInteger(size) && size >= 0 && size <= maxPhotoBytes))) return id;
}

function audioCoverFileId(block: Record<string, unknown> | undefined) {
  if (block?.["@type"] !== "pageBlockAudio" || mediaReference(block)?.kind !== "audio") return;
  const media = object(block.audio);
  const cover = articleThumbnailFileId(object(media?.album_cover_thumbnail));
  if (cover !== undefined) return cover;
  if (!Array.isArray(media?.external_album_covers)) return;
  for (const thumbnail of media.external_album_covers.slice(0, 16)) {
    const fileId = articleThumbnailFileId(object(thumbnail));
    if (fileId !== undefined) return fileId;
  }
}

function audioView(block: Record<string, unknown>, reference: Extract<ReturnType<typeof mediaReference>, { kind: "audio" }>) {
  const document = articleDocument(block)?.document;
  const voiceNote = block["@type"] === "pageBlockVoiceNote";
  const media = articleMediaFile(block)?.media;
  const durationSeconds = articleMediaDuration(media);
  const waveform = voiceNote ? decodeVoiceWaveform(media?.waveform) : undefined;
  const title = !voiceNote && typeof media?.title === "string" ? media.title.trim().slice(0, 256) : "";
  const artist = !voiceNote && typeof media?.performer === "string" ? media.performer.trim().slice(0, 256) : "";
  const coverFileId = audioCoverFileId(block);
  return { fileId: reference.id, mime: reference.mime, voiceNote,
    ...((title || artist) && { audioTrack: { ...(title && { title }), ...(artist && { artist }) } }),
    ...(coverFileId !== undefined && { coverFileId }),
    ...(durationSeconds !== undefined && { durationSeconds }),
    ...(waveform?.length && { waveform }),
    ...(document?.downloadable && { document }) };
}

function readCaption(block: Record<string, unknown>, pageUrl?: string, recordChange?: RecordArticleChange) {
  const caption = object(block.caption);
  const text = readText(caption?.text ?? emptyText, pageUrl, recordChange);
  const { partial, anchors, ...credit } = readText(caption?.credit ?? emptyText, pageUrl, recordChange);
  return {
    ...text,
    partial: text.partial || partial,
    anchors: [...text.anchors, ...anchors],
    ...(credit.text.trim() ? { credit } : {}),
  };
}

function hasMediaCaption(block: Record<string, unknown>) {
  const type = block["@type"];
  return !!object(block.caption) && (type === "pageBlockPhoto" || type === "pageBlockDocument" || type === "pageBlockMap"
    || !!articleMediaFile(block));
}

const horizontalAlignment = new Map<string, "left" | "center" | "right">([
  ["pageBlockHorizontalAlignmentLeft", "left"], ["pageBlockHorizontalAlignmentCenter", "center"],
  ["pageBlockHorizontalAlignmentRight", "right"],
]);
const verticalAlignment = new Map<string, "top" | "middle" | "bottom">([
  ["pageBlockVerticalAlignmentTop", "top"], ["pageBlockVerticalAlignmentMiddle", "middle"],
  ["pageBlockVerticalAlignmentBottom", "bottom"],
]);

function readTable(value: unknown, maximumCells: number, pageUrl?: string, recordChange?: RecordArticleChange) {
  type Table = Extract<InstantViewArticle["blocks"][number], { kind: "table" }>;
  const rows: Table["rows"] = [];
  let used = 0;
  if (!Array.isArray(value) || !maximumCells) return { rows, used, partial: true };
  let partial = value.length > 30;
  const span = (value: unknown, limit: number) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 1;
    if (value > limit) partial = true;
    return Math.min(Math.max(value, 1), limit);
  };
  for (const row of value.slice(0, 30)) {
    if (!Array.isArray(row)) { partial = true; continue; }
    const count = Math.min(row.length, 20, maximumCells - used);
    partial ||= count < row.length;
    used += count;
    rows.push(row.slice(0, count).map((value) => {
      const cell = object(value);
      const invisible = cell?.["@type"] === "pageBlockTableCell" && cell.text == null;
      const { partial: incomplete, anchors, ...content } = readText(invisible ? emptyText : cell?.text, pageUrl, recordChange);
      partial ||= incomplete;
      const horizontal = object(cell?.align)?.["@type"];
      const vertical = object(cell?.valign)?.["@type"];
      const align = typeof horizontal === "string" ? horizontalAlignment.get(horizontal) : undefined;
      const verticalAlign = typeof vertical === "string" ? verticalAlignment.get(vertical) : undefined;
      return { ...content, ...(anchors.length && { anchors }), ...(invisible && { invisible: true as const }),
        header: cell?.is_header === true, colSpan: span(cell?.colspan, 20),
        rowSpan: span(cell?.rowspan, 30), align, verticalAlign };
    }));
  }
  return { rows, used, partial };
}

function listItemBlocks(item: Record<string, unknown> | undefined) {
  if (item?.["@type"] === "pageBlockListItem") return pageBlocks(item);
}

function readList(value: unknown, readChildren: (values: unknown[]) => InstantViewArticle["blocks"]) {
  const items: InstantViewList["items"] = [];
  if (!Array.isArray(value)) return { items, partial: true };
  let partial = value.length > 64;
  for (const entry of value.slice(0, 64)) {
    const item = object(entry);
    const children = listItemBlocks(item);
    if (!item || !children) { partial = true; continue; }
    const blocks = readChildren(children);
    if (!blocks.length) { partial = true; continue; }
    const type = item.type;
    const numbering = type === "1" || type === "a" || type === "A" || type === "i" || type === "I" ? type : undefined;
    const value = item.value;
    items.push({ blocks, numbering,
      value: numbering && typeof value === "number" && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
        ? value : undefined,
      label: typeof item.label === "string" ? item.label.slice(0, 32) : undefined,
      checked: item.has_checkbox === true ? item.is_checked === true : undefined,
    });
  }
  return { items, partial };
}

function richQuoteBlocks(block: Record<string, unknown> | undefined) {
  if (block?.["@type"] !== "pageBlockBlockQuote") return;
  const children = pageBlocks(block);
  if (children?.slice(0, maxInstantViewBlocks).some((child) => object(child)?.["@type"] !== "pageBlockParagraph")) return children;
}

function readQuote(block: Record<string, unknown>, budget: ArticleBudget, pageUrl?: string, recordChange?: RecordArticleChange) {
  type Quote = Extract<InstantViewArticle["blocks"][number], { kind: "quoteGroup" }>;
  const expandable = block["@type"] === "pageBlockExpandableBlockQuote";
  const nested = pageBlocks(block);
  const children = nested ? takeArticleBlocks(nested, budget) : [{ "@type": "pageBlockParagraph", text: block.text }];
  const paragraphs: Quote["paragraphs"] = [];
  let partial = false;
  for (const value of children) {
    const child = object(value);
    if (child?.["@type"] !== "pageBlockParagraph") { partial = true; continue; }
    const { partial: incomplete, anchors, ...text } = readText(blockTextSource(child), pageUrl, recordChange);
    partial ||= incomplete;
    if (text.text.trim() || anchors.length) paragraphs.push({ kind: "paragraph", ...text, ...(anchors.length && { anchors }) });
  }
  const { partial: incomplete, anchors: creditAnchors, ...credit } = readText(block.credit ?? emptyText, pageUrl, recordChange);
  partial ||= incomplete;
  return { paragraphs, credit: credit.text.trim() || creditAnchors.length
    ? { ...credit, ...(creditAnchors.length && { anchors: creditAnchors }) } : undefined, expandable, partial };
}

function articleTimestamp(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647 ? value : undefined;
}

function relatedArticles(value: unknown, selectPhoto?: SelectPhoto) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry) => {
    const article = object(entry);
    if (article?.["@type"] !== "pageBlockRelatedArticle" || typeof article.url !== "string") return [];
    const url = webLink(article.url)?.href;
    if (!url || url.length > 4096) return [];
    const text = (value: unknown, limit: number) => typeof value === "string" ? value.trim().slice(0, limit) : "";
    const publishedAt = articleTimestamp(article.publish_date);
    return [{ url, title: text(article.title, 512), description: text(article.description, 1024),
      author: text(article.author, 256), ...(publishedAt === undefined ? {} : { publishedAt }),
      previewFileId: selectPhoto?.(object(article.photo)?.sizes)?.preview }];
  });
}

export const tdRichButtonStyles = {
  buttonStylePrimary: "primary",
  buttonStyleDanger: "danger",
  buttonStyleSuccess: "success",
  buttonStyleLink: "link",
} as const;

export function articleButtonAction(button: Record<string, unknown> | undefined, label: string): ArticleButton | undefined {
  const type = object(button?.type);
  if (button?.["@type"] !== "inlineButton" || !label.trim() || label.length > 256) return;
  const styleType = object(button.style)?.["@type"];
  const style = typeof styleType === "string" && Object.hasOwn(tdRichButtonStyles, styleType)
    ? tdRichButtonStyles[styleType as keyof typeof tdRichButtonStyles] : undefined;
  if (type?.["@type"] === "inlineKeyboardButtonTypeUrl" && typeof type.url === "string") {
    const url = articleWebLink(type.url)?.href;
    if (url && url.length <= 4096) return { kind: "url", label, url, ...(style && { style }) };
  } else if (type?.["@type"] === "inlineKeyboardButtonTypeCopyText" && typeof type.text === "string"
    && type.text.length > 0 && type.text.length <= 256) return { kind: "copy", label, text: type.text, ...(style && { style }) };
  else if (type?.["@type"] === "inlineKeyboardButtonTypeUser" && typeof type.user_id === "number"
    && Number.isSafeInteger(type.user_id) && type.user_id > 0) return { kind: "profile", label, userId: type.user_id, ...(style && { style }) };
  else if (type?.["@type"] === "inlineKeyboardButtonTypeDisabled") return { kind: "disabled", label, ...(style && { style }) };
}

export function articleButtons(values: unknown, pageUrl?: string, recordChange?: RecordArticleChange) {
  if (!Array.isArray(values)) return { buttons: [], partial: true };
  const buttons: ArticleButton[] = [];
  let partial = values.length > 20;
  for (const value of values.slice(0, 20)) {
    const button = object(value);
    if (button?.["@type"] !== "inlineButton") { partial = true; continue; }
    const label = readText(button.text, pageUrl, recordChange);
    const visibleLabel = maskSpoilers(label.text, label.styles);
    const text = visibleLabel.slice(0, 256);
    partial ||= label.partial || visibleLabel.length > text.length;
    if (!text) { partial = true; continue; }
    const action = articleButtonAction(button, text);
    partial ||= !action;
    const { styles, customEmoji, formulas } = label;
    const labelFormat = text === label.text
      && ((styles?.length && styles.length <= 64) || customEmoji?.length || formulas?.length)
      ? { ...(styles && styles.length <= 64 && { styles }), customEmoji, formulas } : undefined;
    buttons.push({ ...(action ?? { kind: "disabled", label: text }), ...(labelFormat && { labelFormat }) });
  }
  return { buttons, partial };
}

const mediaFileExtensions = new Map([
  ["video/mp4", "mp4"], ["video/webm", "webm"], ["video/quicktime", "mov"], ["image/gif", "gif"],
  ["audio/mpeg", "mp3"], ["audio/mp4", "m4a"], ["audio/ogg", "ogg"], ["audio/wav", "wav"], ["audio/flac", "flac"],
]);

function articleDocument(block: Record<string, unknown> | undefined) {
  const document = block?.["@type"] === "pageBlockDocument" ? object(block.document) : undefined;
  const fallback = !document && block?.has_spoiler !== true ? articleMediaFile(block) : undefined;
  const file = fallback ? fallback.file : object(document?.document);
  const fileId = file?.id;
  if (typeof fileId !== "number" || !Number.isSafeInteger(fileId) || fileId <= 0) return;
  const bytes = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
  const exact = bytes(file?.size);
  const sizeBytes = exact || bytes(file?.expected_size);
  const mime = fallback?.media?.mime_type;
  const extension = typeof mime === "string" ? mediaFileExtensions.get(readAudioPlaybackMime(mime) ?? mime) : undefined;
  return { fileId, document: { name: documentName(document?.file_name ?? fallback?.media?.file_name,
    extension && `Telegram media.${extension}`), downloadable: sizeBytes <= maxDocumentBytes,
    ...(sizeBytes ? { sizeBytes, approximateSize: !exact } : {}) } };
}

function mapPoint(block: Record<string, unknown> | undefined) {
  if (block?.["@type"] !== "pageBlockMap") return;
  const location = object(block.location);
  if (location?.["@type"] !== "location") return;
  const zoom = typeof block.zoom === "number" && Number.isInteger(block.zoom) && block.zoom > 0
    ? Math.min(20, Math.max(13, block.zoom)) : 15;
  const { width, height } = block;
  const dimensions = typeof width === "number" && typeof height === "number"
    && Number.isSafeInteger(width) && Number.isSafeInteger(height) && width >= 16 && height >= 16
    ? fitMapDimensions(width, height) : undefined;
  return articleMapPoint.safeParse({ latitude: location.latitude, longitude: location.longitude, zoom,
    ...(dimensions && { dimensions }) }).data;
}

function fitMapDimensions(width: number, height: number) {
  const scale = Math.min(1, 1024 / Math.max(width, height));
  const fitted = { width: Math.round(width * scale), height: Math.round(height * scale) };
  if (fitted.width >= 16 && fitted.height >= 16) return fitted;
}

const maxArticleDepth = 6;

type ArticleBudget = { remaining: number; partial: boolean };

function takeArticleBlocks(values: unknown[], budget: ArticleBudget) {
  const count = Math.min(values.length, budget.remaining);
  budget.remaining -= count;
  budget.partial ||= count < values.length;
  return values.slice(0, count);
}

function* boundedBlocks(values: unknown[], budget: ArticleBudget) {
  for (const value of values) {
    if (budget.remaining === 0) { budget.partial = true; return; }
    budget.remaining--;
    yield articleBlock(value);
  }
}

function embeddedPostMetadata(block: Record<string, unknown>) {
  const candidate = typeof block.url === "string" && block.url.length <= 4096 ? block.url : "";
  const url = candidate ? canonicalTelegramMessageLink(candidate) ?? webLink(candidate)?.href : undefined;
  const source = url && url.length <= 4096 ? url : undefined;
  const author = typeof block.author === "string" ? block.author.trim().slice(0, 256) : "";
  return { source, author, publishedAt: articleTimestamp(block.date) };
}

function articleChatLink(block: Record<string, unknown> | undefined) {
  return block?.["@type"] === "pageBlockChatLink" && typeof block.username === "string"
    ? canonicalTelegramPublicChatLink(`@${block.username}`) : undefined;
}

export function readInstantView(value: unknown, url?: string, selectPhoto?: SelectPhoto): InstantViewArticle | null {
  const page = object(value);
  const contents = pageBlocks(page);
  if (page?.["@type"] !== "webPageInstantView" || !contents) return null;
  const pageUrl = url ? webLink(url)?.href : undefined;
  const budget = { remaining: maxInstantViewBlocks, partial: page.is_full !== true };
  const changes: NonNullable<InstantViewArticle["changes"]> = [];
  let remainingComparisons = 64;
  const recordChange: RecordArticleChange = (oldText, newText) => {
    if (changes.length >= 32 || remainingComparisons <= 0) return;
    remainingComparisons--;
    const original = changeExcerpt(oldText);
    const current = changeExcerpt(newText);
    if (original !== current && (original.trim() || current.trim())) changes.push({ original, current });
  };
  let tableCells = 400;
  let embedHtmlRemaining = 128 * 1024;

  function readBlocks(values: unknown[], depth: number): InstantViewArticle["blocks"] {
    const blocks: InstantViewArticle["blocks"] = [];
    let pendingAnchors: string[] = [];
    for (const block of boundedBlocks(values, budget)) {
      if (block?.["@type"] === "pageBlockAnchor" && validAnchor(block.name) && block.name && pendingAnchors.length < 32) {
        pendingAnchors.push(block.name);
        continue;
      }
      const kind = typeof block?.["@type"] === "string" ? blockKinds.get(block["@type"]) : undefined;
      const variants = selectPhoto && instantViewPhotoVariants(block, selectPhoto);
      const playable = mediaReference(block);
      const gallery = block && galleryKind(block);
      const table = block?.["@type"] === "pageBlockTable" && readTable(block.cells, tableCells, pageUrl, recordChange);
      const list = block?.["@type"] === "pageBlockList" && depth < maxArticleDepth
        && readList(block.items, (children) => readBlocks(children, depth + 1));
      const richQuote = richQuoteBlocks(block);
      const quote = !richQuote && block && (block["@type"] === "pageBlockBlockQuote" || block["@type"] === "pageBlockPullQuote"
        || block["@type"] === "pageBlockExpandableBlockQuote") && readQuote(block, budget, pageUrl, recordChange);
      const details = block?.["@type"] === "pageBlockDetails";
      const embeddedPost = block?.["@type"] === "pageBlockEmbeddedPost";
      const webEmbed = block?.["@type"] === "pageBlockEmbedded";
      const chatUrl = articleChatLink(block);
      const attachment = articleDocument(block);
      const point = mapPoint(block);
      const photoDestination = block && articlePhotoDestination(block);
      const missingMedia = block && !variants && !playable && !attachment && !point && (photoDestination || hasMediaCaption(block));
      const buttonRow = block?.["@type"] === "pageBlockButtonRow" && articleButtons(block.buttons, pageUrl, recordChange);
      const divider = block?.["@type"] === "pageBlockDivider";
      const related = block?.["@type"] === "pageBlockRelatedArticles" ? relatedArticles(block.articles, selectPhoto) : undefined;
      const math = block?.["@type"] === "pageBlockMathematicalExpression" && typeof block.expression === "string"
        && block.expression.length <= 4096 && block.expression.trim() ? block.expression : undefined;
      if ((!kind && !variants && !playable && !gallery && !table && !list && !quote && !divider && !related && !details && !chatUrl && !point && !embeddedPost && !webEmbed && !attachment && !missingMedia && !buttonRow && !math) || !block) { budget.partial = true; continue; }
      const { partial: incomplete, anchors, ...content } = math
        ? { partial: false, anchors: [], text: math }
        : variants || playable || gallery || point || embeddedPost || webEmbed || attachment || missingMedia ? readCaption(block, pageUrl, recordChange)
        : readText(chatUrl ? { "@type": "richTextPlain", text: typeof block.title === "string" ? block.title : "" }
          : list || quote || richQuote || divider || buttonRow ? emptyText : related || details ? block.header ?? emptyText
          : table ? block.caption ?? emptyText : blockTextSource(block), pageUrl, recordChange);
      budget.partial ||= incomplete;
      const names = [...new Set([...pendingAnchors, ...anchors])];
      budget.partial ||= names.length > 32;
      const text = { ...content, ...(names.length ? { anchors: names.slice(0, 32) } : {}) };
      if (math) {
        blocks.push({ kind: "math", ...text });
        pendingAnchors = [];
      } else if (block["@type"] === "pageBlockAuthorDate") {
        const publishedAt = articleTimestamp(block.publish_date);
        if (!content.text.trim() && publishedAt === undefined) {
          pendingAnchors = names.slice(0, 32);
          continue;
        }
        blocks.push({ kind: "byline", ...text, publishedAt });
        pendingAnchors = [];
      } else if (webEmbed) {
        const target = typeof block.url === "string" ? webLink(block.url)?.href : undefined;
        const source = target && target.length <= 4096 ? target : undefined;
        const staticHtml = (source || !block.url) && typeof block.html === "string" && block.html.length <= 32768
          && block.html.length <= embedHtmlRemaining && block.html.trim() ? block.html : undefined;
        if (staticHtml) embedHtmlRemaining -= staticHtml.length;
        budget.partial ||= !source || (typeof block.html === "string" && !!block.html.trim());
        if (!variants && !source && !staticHtml && !content.text.trim() && !("credit" in content && content.credit)) {
          pendingAnchors = names.slice(0, 32);
          continue;
        }
        const photo = variants ? photoView(block, variants).photo : undefined;
        const { width, height } = block;
        const dimensions = typeof width === "number" && typeof height === "number"
          && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
          && width <= maxPhotoEdge && height <= maxPhotoEdge ? { width, height } : undefined;
        blocks.push({ kind: "webEmbed", ...text, photo, source, ...(staticHtml && { staticHtml }), ...(dimensions && { dimensions }),
          ...(block.is_full_width === true && { fullWidth: true }),
          ...(typeof block.allow_scrolling === "boolean" && { allowScrolling: block.allow_scrolling }) });
        pendingAnchors = [];
      } else if (variants) {
        blocks.push({ kind: "photo", ...text, ...photoView(block, variants) });
        pendingAnchors = [];
      } else if (playable?.kind === "video") {
        blocks.push({ kind: "video", ...text, video: videoView(block, playable) });
        pendingAnchors = [];
      } else if (playable?.kind === "audio") {
        blocks.push({ kind: "audio", ...text, audio: audioView(block, playable) });
        pendingAnchors = [];
      } else if (richQuote) {
        const children = depth < maxArticleDepth ? readBlocks(richQuote, depth + 1) : [];
        const { partial, anchors: creditAnchors, ...credit } = readText(block.credit ?? emptyText, pageUrl, recordChange);
        budget.partial ||= partial || !children.length;
        if (children.length) {
          blocks.push({ kind: "richQuote", ...text, blocks: children,
            ...((credit.text.trim() || creditAnchors.length) && {
              credit: { ...credit, ...(creditAnchors.length && { anchors: creditAnchors }) },
            }) });
          pendingAnchors = [];
        } else pendingAnchors = [...new Set([...names, ...creditAnchors])].slice(0, 32);
      } else if (quote) {
        budget.partial ||= quote.partial || !quote.paragraphs.length;
        if (quote.paragraphs.length) {
          blocks.push({ kind: "quoteGroup", ...text, paragraphs: quote.paragraphs,
            credit: quote.credit, expandable: quote.expandable,
            ...(block["@type"] === "pageBlockPullQuote" && { pull: true }) });
          pendingAnchors = [];
        } else pendingAnchors = names.slice(0, 32);
      } else if (details || embeddedPost) {
        const nested = pageBlocks(block);
        const children = depth < maxArticleDepth && nested ? readBlocks(nested, depth + 1) : [];
        if (embeddedPost) {
          const metadata = embeddedPostMetadata(block);
          budget.partial ||= !nested || (nested.length > 0 && !children.length)
            || (!!block.url && !metadata.source);
          if (children.length || metadata.source || text.text || ("credit" in text && text.credit)) {
            blocks.push({ kind: "embeddedPost", ...text, ...metadata, avatarFileId: articleAvatarFileId(block, selectPhoto), blocks: children });
            pendingAnchors = [];
          } else {
            budget.partial = true;
            pendingAnchors = names.slice(0, 32);
          }
        } else if (children.length) {
          blocks.push({ kind: "details", ...text, open: block.is_open === true, blocks: children });
          pendingAnchors = [];
        } else {
          budget.partial = true;
          pendingAnchors = names.slice(0, 32);
        }
      } else if (chatUrl) {
        blocks.push({ kind: "chatLink", ...text, url: chatUrl, avatarFileId: articleAvatarFileId(block) });
        pendingAnchors = [];
      } else if (attachment) {
        blocks.push({ kind: "document", ...text, ...attachment });
        pendingAnchors = [];
      } else if (missingMedia) {
        budget.partial = true;
        if (photoDestination || content.text.trim() || ("credit" in content && content.credit)) {
          blocks.push({ kind: "missingMedia", ...text, ...(photoDestination && { url: photoDestination }) });
          pendingAnchors = [];
        } else pendingAnchors = names.slice(0, 32);
      } else if (point) {
        blocks.push({ kind: "map", ...text, point });
        pendingAnchors = [];
      } else if (buttonRow) {
        budget.partial ||= buttonRow.partial || !buttonRow.buttons.length;
        if (buttonRow.buttons.length) {
          const type = object(block.align)?.["@type"];
          const align = typeof type === "string" ? horizontalAlignment.get(type) : undefined;
          blocks.push({ kind: "buttons", ...text, buttons: buttonRow.buttons, align });
          pendingAnchors = [];
        } else pendingAnchors = names.slice(0, 32);
      } else if (divider) {
        blocks.push({ kind: "divider", ...text });
        pendingAnchors = [];
      } else if (related) {
        budget.partial ||= !Array.isArray(block.articles) || related.length !== block.articles.length || !related.length;
        if (related.length) {
          blocks.push({ kind: "related", ...text, articles: related });
          pendingAnchors = [];
        } else pendingAnchors = names.slice(0, 32);
      } else if (list) {
        budget.partial ||= list.partial || !list.items.length;
        if (list.items.length) {
          blocks.push({ kind: "list", ...text, items: list.items });
          pendingAnchors = [];
        } else pendingAnchors = names.slice(0, 32);
      } else if (table) {
        tableCells -= table.used;
        budget.partial ||= table.partial || !table.used;
        if (table.used) {
          blocks.push({ kind: "table", ...text, rows: table.rows, bordered: block.is_bordered === true,
            striped: block.is_striped === true, compact: block.is_compact === true });
          pendingAnchors = [];
        } else pendingAnchors = names.slice(0, 32);
      } else if (gallery) {
        type Gallery = Extract<InstantViewArticle["blocks"][number], { kind: "collage" | "slideshow" }>;
        const media: Gallery["media"] = [];
        const children = galleryChildren(block, budget);
        let slideAnchors: string[] = [];
        for (const childValue of children) {
          const child = object(childValue);
          if (child?.["@type"] === "pageBlockAnchor" && validAnchor(child.name) && child.name && slideAnchors.length < 32) {
            slideAnchors.push(child.name);
            continue;
          }
          if (!child) {
            budget.partial = true;
            continue;
          }
          const photo = child["@type"] === "pageBlockPhoto" && selectPhoto && instantViewPhotoVariants(child, selectPhoto);
          const playable = mediaReference(child);
          const attachment = articleDocument(child);
          const point = mapPoint(child);
          const photoDestination = articlePhotoDestination(child);
          const missingMedia = !photo && !playable && !attachment && !point;
          if (missingMedia) budget.partial = true;
          if (missingMedia && !photoDestination && !hasMediaCaption(child)) continue;
          const { partial: incomplete, anchors, ...caption } = readCaption(child, pageUrl, recordChange);
          if (missingMedia && !photoDestination && !caption.text.trim() && !caption.credit) continue;
          const names = [...new Set([...slideAnchors, ...anchors])];
          slideAnchors = [];
          budget.partial ||= incomplete || names.length > 32;
          const text = { ...caption, ...(names.length ? { anchors: names.slice(0, 32) } : {}) };
          if (photo) media.push({ kind: "photo", ...text, ...photoView(child, photo) });
          else if (playable?.kind === "video") media.push({ kind: "video", ...text, video: videoView(child, playable) });
          else if (playable?.kind === "audio") media.push({ kind: "audio", ...text, audio: audioView(child, playable) });
          else if (attachment) media.push({ kind: "document", ...text, ...attachment });
          else if (point) media.push({ kind: "map", ...text, point });
          else media.push({ kind: "missingMedia", ...text, ...(photoDestination && { url: photoDestination }) });
        }
        const last = media.at(-1);
        if (!last) {
          budget.partial = true;
          pendingAnchors = [...new Set([...names, ...slideAnchors])].slice(0, 32);
          continue;
        }
        if (slideAnchors.length) {
          const anchors = [...new Set([...(last.anchors ?? []), ...slideAnchors])];
          budget.partial ||= anchors.length > 32;
          last.anchors = anchors.slice(0, 32);
        }
        blocks.push({ kind: gallery, ...text, media });
        pendingAnchors = [];
      } else if (kind && content.text.trim()) {
        if (kind === "heading") {
          const size = block.size;
          const level = block["@type"] === "pageBlockSubheader" ? 3
            : block["@type"] === "pageBlockSectionHeading" && typeof size === "number" && Number.isInteger(size)
              && size >= 1 && size <= 6 ? size : undefined;
          blocks.push({ kind, ...text, ...(level === undefined ? {} : { level }) });
        } else if (kind === "code") {
          const language = typeof block.language === "string" ? block.language.trim() : "";
          blocks.push({ kind, ...text, ...(/^[a-z0-9][a-z0-9+#._-]{0,31}$/i.test(language) && { language }) });
        } else blocks.push({ kind, ...text });
        pendingAnchors = [];
      } else pendingAnchors = names.slice(0, 32);
    }
    if (pendingAnchors.length) blocks.push({ kind: "anchor", text: "", anchors: [...new Set(pendingAnchors)] });
    return blocks;
  }
  const blocks = readBlocks(contents, 0);
  if (!changes.length && !blocks.some((block) => block.kind !== "anchor")) return null;
  const feedback = object(page.feedback_link);
  const feedbackUrl = feedback?.["@type"] === "internalLinkTypeBotStart"
    && typeof feedback.bot_username === "string" && feedback.bot_username.length <= 64
    && typeof feedback.start_parameter === "string" && feedback.start_parameter.length <= 64
    ? canonicalTelegramBotStartLink(`https://t.me/${feedback.bot_username}?start=${feedback.start_parameter}`)
    : undefined;
  return { rtl: page.is_rtl === true, partial: budget.partial, blocks,
    ...(changes.length > 0 && { changes }),
    ...(page.is_full === false && { incompleteSource: true }), ...(feedbackUrl && { feedbackUrl }) };
}

type ArticleMediaBlock = { block: Record<string, unknown>; gallery: unknown[] };

function* mediaBlocks(values: unknown[], budget: ArticleBudget = { remaining: maxInstantViewBlocks, partial: false },
  depth = 0): Generator<ArticleMediaBlock> {
  for (const block of boundedBlocks(values, budget)) {
    if (!block) continue;
    yield { block, gallery: galleryKind(block) ? galleryChildren(block, budget) : [] };
    const nested = pageBlocks(block);
    if (nested && (block["@type"] === "pageBlockDetails" || block["@type"] === "pageBlockEmbeddedPost" || richQuoteBlocks(block))) {
      if (depth < maxArticleDepth) yield* mediaBlocks(nested, budget, depth + 1);
    } else if (nested && (block["@type"] === "pageBlockBlockQuote" || block["@type"] === "pageBlockPullQuote"
      || block["@type"] === "pageBlockExpandableBlockQuote")) {
      takeArticleBlocks(nested, budget);
    } else if (block["@type"] === "pageBlockList" && depth < maxArticleDepth && Array.isArray(block.items)) {
      for (const entry of block.items.slice(0, 64)) {
        const children = listItemBlocks(object(entry));
        if (children) yield* mediaBlocks(children, budget, depth + 1);
      }
    }
  }
}

export function hasInstantViewChatLink(value: unknown, url: string) {
  const page = object(value);
  const contents = pageBlocks(page);
  if (page?.["@type"] !== "webPageInstantView" || !contents) return false;
  for (const { block } of mediaBlocks(contents)) {
    if (articleChatLink(block) === url) return true;
  }
  return false;
}

export function findInstantViewDocument(value: unknown, id: number) {
  const page = object(value);
  const contents = pageBlocks(page);
  if (page?.["@type"] !== "webPageInstantView" || !contents) return;
  for (const { block, gallery } of mediaBlocks(contents)) {
    const attachment = articleDocument(block);
    if (attachment?.fileId === id) return attachment;
    for (const child of gallery) {
      const match = articleDocument(object(child));
      if (match?.fileId === id) return match;
    }
  }
}

export function findInstantViewPhotoDownload(value: unknown, id: number, selectPhoto: SelectPhoto, selectOriginal: SelectPhoto) {
  const page = object(value);
  const contents = pageBlocks(page);
  if (page?.["@type"] !== "webPageInstantView" || !contents || page.has_protected_content === true) return;
  const original = (block: Record<string, unknown> | undefined) => {
    if (block?.["@type"] !== "pageBlockPhoto" || block.has_spoiler === true || block.has_protected_content === true) return;
    const sizes = object(block.photo)?.sizes;
    if (selectPhoto(sizes)?.large === id) return selectOriginal(sizes)?.large;
  };
  for (const { block, gallery } of mediaBlocks(contents)) {
    const fileId = original(block);
    if (fileId !== undefined) return fileId;
    for (const item of gallery) {
      const fileId = original(object(item));
      if (fileId !== undefined) return fileId;
    }
  }
}

export function findInstantViewMap(value: unknown, reference: ArticleMapPoint) {
  const page = object(value);
  const contents = pageBlocks(page);
  if (page?.["@type"] !== "webPageInstantView" || !contents) return;
  for (const { block, gallery } of mediaBlocks(contents)) {
    const candidates = galleryKind(block) ? gallery.map(object) : [block];
    for (const candidate of candidates) {
      const point = mapPoint(candidate);
      if (point?.latitude === reference.latitude && point.longitude === reference.longitude && point.zoom === reference.zoom
        && (!reference.dimensions || (point.dimensions?.width === reference.dimensions.width
          && point.dimensions?.height === reference.dimensions.height))) return point;
    }
  }
}

export function findInstantViewPlayback(value: unknown, id: number) {
  const page = object(value);
  const contents = pageBlocks(page);
  if (page?.["@type"] !== "webPageInstantView" || !contents) return;
  for (const { block, gallery } of mediaBlocks(contents)) {
    const media = mediaReference(block);
    if (media?.id === id) return media;
    for (const child of gallery) {
      const match = mediaReference(object(child));
      if (match?.id === id) return match;
    }
  }
}

export function findInstantViewPhoto(value: unknown, id: number, selectPhoto: SelectPhoto) {
  const page = object(value);
  const contents = pageBlocks(page);
  if (page?.["@type"] !== "webPageInstantView" || !contents) return;
  for (const { block, gallery } of mediaBlocks(contents)) {
    if (articleAvatarFileId(block, selectPhoto) === id) return { preview: id, large: id };
    if (videoPosterFileId(block) === id || audioCoverFileId(block) === id) return { preview: id, large: id };
    if (block["@type"] === "pageBlockRelatedArticles"
      && relatedArticles(block.articles, selectPhoto).some(({ previewFileId }) => previewFileId === id)) {
      return { preview: id, large: id };
    }
    const variants = instantViewPhotoVariants(block, selectPhoto);
    if (variants?.large === id) return variants;
    for (const child of gallery) {
      const item = object(child);
      if (videoPosterFileId(item) === id || audioCoverFileId(item) === id) return { preview: id, large: id };
      const match = item?.["@type"] === "pageBlockPhoto" ? instantViewPhotoVariants(item, selectPhoto) : undefined;
      if (match?.large === id) return match;
    }
  }
}

function* instantViewTextNodes(article: ReturnType<typeof readInstantView>) {
  const pending: unknown[] = article ? [...article.blocks] : [];
  while (pending.length) {
    const node = object(pending.pop());
    if (!node) continue;
    yield node;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (Array.isArray(child)) pending.push(...child);
          else pending.push(child);
        }
      } else if (object(value)) pending.push(value);
    }
  }
}

export function findInstantViewIcon(value: unknown, id: number, url: string, selectPhoto: SelectPhoto) {
  for (const node of instantViewTextNodes(readInstantView(value, url, selectPhoto))) {
    const match = Array.isArray(node.icons) ? node.icons.find((icon: InstantViewIconRange) => icon.fileId === id) : undefined;
    if (match) return match as InstantViewIconRange;
  }
}

export function hasInstantViewMention(value: unknown, userId: number, url: string, selectPhoto: SelectPhoto) {
  for (const node of instantViewTextNodes(readInstantView(value, url, selectPhoto))) {
    if (node.kind === "profile" && node.userId === userId) return true;
    if (Array.isArray(node.mentions) && node.mentions.some((mention) => mention.userId === userId)) return true;
  }
  return false;
}
