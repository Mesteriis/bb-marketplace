import type { DocumentInfo } from "../core/contract.ts";
import { documentIconAssets } from "./document-icon-assets.ts";

const extensions = new Map<string, keyof typeof documentIconAssets>();
const formats = {
  pdf: ["pdf"],
  word: ["doc", "docx", "docm", "dot", "dotx", "odt", "rtf", "pages"],
  table: ["xls", "xlsx", "xlsm", "xlsb", "ods", "csv", "tsv", "numbers"],
  powerpoint: ["ppt", "pptx", "pptm", "pps", "ppsx", "odp", "key"],
  zip: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "tgz", "tbz2"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "heif", "avif", "bmp", "tiff", "tif", "ico", "psd"],
  audio: ["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "aiff", "wma"],
  video: ["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv", "mpeg", "mpg"],
  markdown: ["md", "markdown"],
  xml: ["xml", "html", "css", "ts", "tsx", "js", "jsx", "json", "yaml", "yml", "py", "rs", "go", "sh", "sql", "toml"],
  epub: ["epub", "mobi", "azw", "azw3", "fb2"],
} as const satisfies Partial<Record<keyof typeof documentIconAssets, readonly string[]>>;

for (const [icon, endings] of Object.entries(formats) as [keyof typeof formats, readonly string[]][]) {
  for (const ending of endings) extensions.set(ending, icon);
}

export function documentIconKind({ name, playbackMime, audioTrack }: Pick<DocumentInfo, "name" | "playbackMime" | "audioTrack">) {
  if (audioTrack || playbackMime?.startsWith("audio/")) return "audio";
  if (playbackMime?.startsWith("video/")) return "video";
  const extension = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1];
  return (extension ? extensions.get(extension.toLowerCase()) : undefined) ?? "document";
}

export function DocumentIcon({ document }: { document: DocumentInfo }) {
  const kind = documentIconKind(document);
  return <img className="mtg-document-icon" data-document-kind={kind} src={documentIconAssets[kind]} alt="" aria-hidden="true" />;
}
