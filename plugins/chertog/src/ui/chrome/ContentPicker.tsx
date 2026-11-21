// Choosing what a tile or a new tab shows. Providers are sections; one search
// field filters all of them. An item that is already open in this layout
// focuses its tile instead of opening a second view, and at the tile limit a
// new tile becomes a question: a tab in the group, or a place the user picks.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { classes, moveByArrows, usePendingFocus } from "./primitives.tsx";
import { chromeStrings } from "./strings.ts";
import type { ContentChoice, ContentItem, ContentPlacement, ContentSection, ContentTarget } from "./types.ts";

const text = chromeStrings.picker;

const HEADINGS: Record<ContentTarget, string> = {
  "empty-tile": text.headingEmptyTile,
  tab: text.headingTab,
  "new-tile": text.headingNewTile,
};

export interface ContentPickerProps {
  target: ContentTarget;
  sections: readonly ContentSection[];
  /** How many tiles the layout has now. */
  tileCount: number;
  /** How many tiles a layout may have. */
  tileLimit: number;
  /** The id of the heading, for a dialog that is labelled by it. */
  headingId?: string;
  onOpen: (choice: ContentChoice) => void;
  /** The chosen item is already open in this layout: focus its tile. */
  onFocusExisting: (tileId: string) => void;
}

/** The item the limit question is about, by id: its entry is read from the current sections each time. */
interface PendingChoice {
  providerId: string;
  itemId: string;
}

function matches(item: ContentItem, query: string): boolean {
  return [item.title, item.context, item.status].some((field) => field?.toLocaleLowerCase().includes(query) === true);
}

const itemKey = (providerId: string, itemId: string) => JSON.stringify([providerId, itemId]);

export function ContentPicker(props: ContentPickerProps) {
  const { target, sections, tileCount, tileLimit } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const requestFocus = usePendingFocus(rootRef);
  const [search, setSearch] = useState("");
  const [pendingChoice, setPending] = useState<PendingChoice | null>(null);
  const generatedHeadingId = useId();
  const headingId = props.headingId ?? generatedHeadingId;
  const ids = { base: useId(), limit: useId() };

  const query = search.trim().toLocaleLowerCase();
  const atLimit = target === "new-tile" && tileCount >= tileLimit;
  // The sections can change while the question is open. It stands only while
  // its provider is ready and still lists the item: a provider that is
  // loading, missing or denied offers nothing, whatever items it carries. An
  // item that got opened meanwhile is focused, not doubled.
  const pendingSection =
    pendingChoice === null ? undefined : sections.find((section) => section.providerId === pendingChoice.providerId && section.state === "ready");
  const pendingItem = pendingSection?.items.find((item) => item.id === pendingChoice?.itemId);
  const pending = pendingChoice !== null && pendingItem !== undefined ? { providerId: pendingChoice.providerId, item: pendingItem } : null;
  const pendingIsStale = pendingChoice !== null && pending === null;
  // A question that lost its ground is forgotten, so it cannot come back
  // by itself when the provider answers again.
  useEffect(() => {
    if (pendingIsStale) setPending(null);
  }, [pendingIsStale]);

  function choose(providerId: string, item: ContentItem) {
    if (item.openInTileId !== undefined) return props.onFocusExisting(item.openInTileId);
    if (atLimit) {
      setPending({ providerId, itemId: item.id });
      requestFocus((container) => container.querySelector<HTMLElement>("[data-limit-default]"));
      return;
    }
    props.onOpen({ providerId, itemId: item.id, placement: "default" });
  }

  function place(placement: ContentPlacement) {
    if (pending === null) return;
    setPending(null);
    if (pending.item.openInTileId !== undefined) return props.onFocusExisting(pending.item.openInTileId);
    props.onOpen({ providerId: pending.providerId, itemId: pending.item.id, placement });
  }

  function cancelLimit() {
    if (pending === null) return;
    const key = itemKey(pending.providerId, pending.item.id);
    setPending(null);
    requestFocus((container) =>
      Array.from(container.querySelectorAll<HTMLElement>("[data-item-key]")).find((element) => element.dataset.itemKey === key),
    );
  }

  function onKeyDown(event: KeyboardEvent) {
    if (pending !== null) {
      if (event.key !== "Escape") return;
      // Escape leaves the question; the surrounding dialog, if any, stays.
      event.stopPropagation();
      cancelLimit();
      return;
    }
    moveByArrows(event, rootRef.current);
  }

  return (
    <div ref={rootRef} className="flex min-h-0 w-full flex-col gap-2 text-sm text-foreground" onKeyDown={onKeyDown}>
      <h2 id={headingId} className="text-sm font-medium">
        {HEADINGS[target]}
      </h2>

      {pending !== null ? (
        <div role="group" aria-labelledby={ids.limit} className="flex flex-col gap-2">
          <h3 id={ids.limit} className="text-xs font-medium">
            {text.limitHeading}
          </h3>
          <p className="text-xs text-muted-foreground">{text.limitText(pending.item.title, tileCount, tileLimit)}</p>
          <div className="flex flex-wrap justify-end gap-1">
            <button type="button" className={classes.button} onClick={cancelLimit}>
              {text.limitCancel}
            </button>
            <button type="button" className={classes.button} onClick={() => place("pick-place")}>
              {text.limitPickPlace}
            </button>
            <button type="button" data-limit-default className={classes.primaryButton} onClick={() => place("tab")}>
              {text.limitAsTab}
            </button>
          </div>
        </div>
      ) : (
        <>
          <input
            type="search"
            data-nav
            data-autofocus
            className={`${classes.input} flex-none`}
            aria-label={text.search}
            placeholder={text.searchPlaceholder}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {sections.length === 0 && <p className={classes.muted}>{text.noProviders}</p>}
          <div className="flex min-h-0 flex-col gap-2 overflow-auto">
            {sections.map((section, index) => {
              const sectionId = `${ids.base}-${index}`;
              const found = query === "" ? section.items : section.items.filter((item) => matches(item, query));
              return (
                <section key={section.providerId} aria-labelledby={sectionId} className="flex flex-col gap-0.5">
                  <h3 id={sectionId} className={classes.sectionHeading}>
                    {section.title}
                  </h3>
                  {section.state === "loading" && (
                    <p role="status" className={classes.muted}>
                      {text.loading}
                    </p>
                  )}
                  {section.state === "missing" && (
                    <p className={classes.muted}>
                      <span className="font-medium text-foreground">{text.missing}</span>. {text.missingHint}
                    </p>
                  )}
                  {section.state === "denied" && <p className={classes.error}>{text.denied}</p>}
                  {section.state === "ready" && section.items.length === 0 && <p className={classes.muted}>{text.empty}</p>}
                  {section.state === "ready" && section.items.length > 0 && found.length === 0 && (
                    <p className={classes.muted}>{text.nothingFound}</p>
                  )}
                  {section.state === "ready" && found.length > 0 && (
                    <ul className="flex flex-col gap-0.5">
                      {found.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            data-nav
                            data-item-key={itemKey(section.providerId, item.id)}
                            className={`flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-state-hover ${classes.focusRing}`}
                            onClick={() => choose(section.providerId, item)}
                          >
                            <span data-item-title className="min-w-0 flex-1 truncate font-medium">
                              {item.title}
                            </span>
                            {item.context !== undefined && <span className="shrink-0 truncate text-muted-foreground">{item.context}</span>}
                            {item.status !== undefined && <span className="shrink-0 text-muted-foreground">{item.status}</span>}
                            {item.openInTileId !== undefined && (
                              <span className="shrink-0 rounded border border-border bg-secondary px-1 text-foreground">{text.alreadyOpen}</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
