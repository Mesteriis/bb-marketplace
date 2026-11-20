import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState } from "react";
import type { StickerPackPreviewData } from "../core/contract.ts";
import { StickerPackPreview } from "./sticker-pack-preview.tsx";

type Request = { query: string } | { offset: number };
type Page = { packs: Array<{ id: string; title: string; link: string }>; next: number | null };
export type StickerPackDiscoveryActions = {
  find: (input: Request) => Promise<Page>;
  load: (link: string, offset: number) => Promise<StickerPackPreviewData | null>;
  install: (link: string, id: string) => Promise<"installed" | "unavailable" | "unknown">;
};

export function StickerPackDiscovery({ actions, onInstalled, emoji = false }: {
  actions: StickerPackDiscoveryActions; onInstalled?: () => void; emoji?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const title = emoji ? tr("Emoji pack") : tr("Sticker pack");
  const packLabel = emoji ? tr("emoji pack") : tr("sticker pack");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<Page>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);

  async function find(input: Request) {
    const current = ++generation.current;
    const more = "offset" in input && input.offset > 0;
    if (!more) setPage(undefined);
    setLoading(true);
    setError("");
    try {
      const result = await actions.find(input);
      if (generation.current !== current) return;
      setPage((previous) => {
        if (!more || !previous) return result;
        const existing = new Set(previous.packs.map(({ id }) => id));
        return { packs: [...previous.packs, ...result.packs.filter(({ id }) => !existing.has(id))], next: result.next };
      });
    } catch {
      if (generation.current === current) setError(tr("Could not find {0}s.", [packLabel]));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }

  const next = page?.next;
  return <div className="mtg-media-choices">
    <button type="button" className="mtg-action" aria-expanded={open} onClick={() => {
      setOpen(!open);
      if (!open) {
        setQuery("");
        void find({ offset: 0 });
      } else {
        ++generation.current;
        setLoading(false);
      }
    }}>{tr("Discover ")}{packLabel}s</button>
    {open && <div role="region" aria-label={tr("{0} discovery", [title])}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement && event.key === "Enter" && !event.nativeEvent.isComposing && query.trim()) {
          event.preventDefault();
          event.stopPropagation();
          void find({ query: query.trim() });
        }
      }}>
      <label>{title}{tr(" name ")}<input type="search" maxLength={80} value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></label>
      <button type="button" className="mtg-action" disabled={!query.trim()} onClick={() => void find({ query: query.trim() })}>{tr("Find ")}{packLabel}s</button>
      <button type="button" className="mtg-action" onClick={() => { setQuery(""); void find({ offset: 0 }); }}>{tr("Trending ")}{packLabel}s</button>
      {loading && <p role="status">{tr("Loading ")}{packLabel}s…</p>}
      {error && <p role="alert">{tr(error)}</p>}
      {page && !page.packs.length && !next && <p>{tr("No ")}{packLabel}{tr("s found.")}</p>}
      {!!page?.packs.length && <ul>{page.packs.map(({ id, title, link }) => <li key={id}>
        <bdi>{title}</bdi>
        <StickerPackPreview emoji={emoji} load={async (offset) => {
          const pack = await actions.load(link, offset);
          return pack?.id === id && (pack.emoji === true) === emoji ? pack : null;
        }} install={async (requested) => {
          if (requested !== id) return "unavailable";
          const result = await actions.install(link, id);
          if (result === "installed") onInstalled?.();
          return result;
        }} />
      </li>)}</ul>}
      {next && <button type="button" className="mtg-action" disabled={loading} onClick={() => void find({ offset: next })}>{tr("More trending packs")}</button>}
    </div>}
  </div>;
}
