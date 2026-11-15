// A To, Cc or Bcc field: addresses as chips, typed text as the uncommitted
// rest. Enter, Tab, comma and semicolon commit the text; a pasted list is
// split; an invalid address stays a chip in the error style with its reason
// as the accessible description; Backspace on an empty field selects the
// last chip, a second Backspace removes it. Suggestions come from an
// injected `suggest` (stored mail only), debounced.
import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { MailAddress } from "../core/model.ts";
import { parseAddress, splitAddressList, type AddressProblem } from "../core/compose-address.ts";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** How long typing rests before suggestions are asked for. */
export const SUGGEST_DEBOUNCE_MS = 150;
/** Shortest text that becomes a chip; anything shorter stays typed. */
export const MIN_CHIP_LENGTH = 3;
/** Longest chip the server takes. */
export const MAX_CHIP_LENGTH = 320;
/** Chips per field. */
export const MAX_CHIPS = 100;

const PROBLEM_TEXT: Record<AddressProblem, string> = {
  empty: "Empty address",
  too_long: "This address is too long",
  control: "This address contains a control character",
  syntax: "This is not an email address",
  non_ascii_local: "Addresses with non-Latin letters before the @ cannot be sent yet",
};

export function addressProblemText(problem: AddressProblem): string {
  return PROBLEM_TEXT[problem];
}

/** A stored address as chip text: "Name <address>", the name quoted when it needs it. */
export function chipText(address: MailAddress): string {
  const name = address.name?.trim() ?? "";
  if (name === "") return address.address;
  const plain = /^[A-Za-z0-9 !#$%&'*+/=?^_`{|}~.-]+$/.test(name);
  return plain ? `${name} <${address.address}>` : `"${name.replace(/["\\]/g, "\\$&")}" <${address.address}>`;
}

/** What a chip shows: the name, else the address. */
function chipLabel(text: string): string {
  const parsed = parseAddress(text);
  if (!parsed.ok) return text;
  return parsed.value.name ?? parsed.value.address;
}

/**
 * Splits typed text into complete pieces and the rest still being typed: a
 * separator (comma, semicolon, line break outside quotes and brackets) ends
 * a piece.
 */
export function splitTyped(text: string): { complete: string[]; rest: string } {
  const pieces = splitAddressList(`${text}\u0001`);
  const last = pieces.pop() ?? "\u0001";
  return { complete: pieces, rest: last.slice(0, -1) };
}

/** A chip's mailbox, lowercased, for duplicates. */
function addressKey(text: string): string {
  const parsed = parseAddress(text);
  return (parsed.ok ? parsed.value.address : text.trim()).toLowerCase();
}

/**
 * Adds pieces as chips: duplicates of existing chips are dropped, pieces
 * shorter than MIN_CHIP_LENGTH stay as the typed rest, and the field keeps
 * at most MAX_CHIPS.
 */
export function addChips(chips: readonly string[], pieces: readonly string[]): { chips: string[]; kept: string[] } {
  const next = [...chips];
  const kept: string[] = [];
  const seen = new Set(next.map(addressKey));
  for (const raw of pieces) {
    const piece = raw.trim();
    if (piece === "") continue;
    if (piece.length < MIN_CHIP_LENGTH || next.length >= MAX_CHIPS) {
      kept.push(piece);
      continue;
    }
    const k = addressKey(piece);
    if (seen.has(k)) continue;
    seen.add(k);
    next.push(piece);
  }
  return { chips: next, kept };
}

export interface RecipientInputProps {
  label: string;
  chips: readonly string[];
  /** The uncommitted text. */
  text: string;
  onChange: (next: { chips: string[]; text: string }) => void;
  /** Suggestions for a prefix; rejections show nothing. */
  suggest: (prefix: string) => Promise<MailAddress[]>;
  autoFocus?: boolean;
}

export function RecipientInput({ label, chips, text, onChange, suggest, autoFocus }: RecipientInputProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<MailAddress[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [open, setOpen] = useState(false);
  const request = useRef(0);
  const suggestRef = useRef(suggest);
  suggestRef.current = suggest;

  // Suggestions follow the typed rest after it rests SUGGEST_DEBOUNCE_MS.
  useEffect(() => {
    const prefix = text.trim();
    const token = ++request.current;
    if (prefix === "" || prefix.length > 64) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const timer = setTimeout(() => {
      suggestRef.current(prefix).then(
        (found) => {
          if (token !== request.current) return;
          const present = new Set(chips.map(addressKey));
          const shown = found.filter((s) => !present.has(s.address.toLowerCase())).slice(0, 10);
          setSuggestions(shown);
          setHighlight(0);
          setOpen(shown.length > 0);
        },
        () => {
          if (token === request.current) setOpen(false);
        },
      );
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // chips only filter the answer; a new prefix asks again.
  }, [text]);

  const commit = (pieces: string[], rest: string) => {
    const added = addChips(chips, pieces);
    const nextText = [...added.kept, rest].filter((piece) => piece !== "").join(", ");
    onChange({ chips: added.chips, text: nextText });
    setSelected(null);
  };

  const pick = (suggestion: MailAddress) => {
    request.current++;
    setOpen(false);
    commit([chipText(suggestion)], "");
    inputRef.current?.focus();
  };

  const remove = (index: number) => {
    onChange({ chips: chips.filter((_, i) => i !== index), text });
    setSelected(null);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (open && suggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((current) => (current + delta + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
        const chosen = suggestions[highlight];
        if (chosen !== undefined) {
          event.preventDefault();
          pick(chosen);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        request.current++;
        setOpen(false);
        return;
      }
    }
    if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey && text.trim() !== "")) {
      if (text.trim() === "") return;
      event.preventDefault();
      const { complete, rest } = splitTyped(text);
      commit([...complete, rest], "");
      return;
    }
    if (event.key === "Backspace" && text === "" && chips.length > 0) {
      event.preventDefault();
      if (selected === null) setSelected(chips.length - 1);
      else remove(selected);
      return;
    }
    if (selected !== null && event.key !== "Shift") setSelected(null);
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text/plain");
    if (!/[,;\n\r]/.test(pasted)) return;
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? text.length;
    const end = input.selectionEnd ?? text.length;
    const combined = text.slice(0, start) + pasted + text.slice(end);
    commit(splitAddressList(combined), "");
  };

  const listId = `${id}-suggestions`;
  const optionId = (index: number) => `${id}-option-${index}`;
  return (
    <div className="relative flex min-w-0 flex-1 items-center">
      <ul aria-label={`${label} recipients`} className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1">
        {chips.map((chip, index) => {
          const parsed = parseAddress(chip);
          const problemId = `${id}-problem-${index}`;
          return (
            <li
              key={`${chip}-${index}`}
              aria-describedby={parsed.ok ? undefined : problemId}
              aria-invalid={parsed.ok ? undefined : true}
              data-selected={selected === index ? "" : undefined}
              title={parsed.ok ? parsed.value.address : addressProblemText(parsed.problem)}
              className={cn(
                "flex h-6 max-w-64 items-center gap-0.5 rounded-md border pl-2 text-xs",
                parsed.ok
                  ? "border-border bg-muted text-foreground"
                  : "border-destructive/60 bg-destructive/10 text-destructive",
                selected === index && "ring-1 ring-ring",
              )}
            >
              <span className="min-w-0 truncate">{chipLabel(chip)}</span>
              {!parsed.ok ? (
                <span id={problemId} className="sr-only">
                  {addressProblemText(parsed.problem)}
                </span>
              ) : null}
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Remove ${chip}`}
                onClick={() => remove(index)}
                className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-state-hover hover:text-foreground"
              >
                <Icon name="X" fallback="Plus" className="size-3" aria-hidden />
              </button>
            </li>
          );
        })}
        <li className="flex min-w-32 flex-1">
          <input
            ref={inputRef}
            autoFocus={autoFocus}
            type="text"
            role="combobox"
            aria-label={label}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={open ? optionId(highlight) : undefined}
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(event) => {
              const { complete, rest } = splitTyped(event.target.value);
              if (complete.length > 0) commit(complete, rest);
              else onChange({ chips: [...chips], text: event.target.value });
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => {
              setOpen(false);
              setSelected(null);
            }}
            className="h-6 w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </li>
      </ul>
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} suggestions`}
          className="absolute left-0 top-full z-20 mt-1 max-h-64 w-full max-w-sm overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.address}
              id={optionId(index)}
              role="option"
              aria-selected={index === highlight}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(suggestion);
              }}
              onMouseEnter={() => setHighlight(index)}
              className={cn(
                "flex cursor-pointer flex-col rounded-sm px-2 py-1 text-sm",
                index === highlight && "bg-state-hover",
              )}
            >
              <span className="truncate text-foreground">{suggestion.name ?? suggestion.address}</span>
              {suggestion.name !== null ? (
                <span className="truncate text-xs text-muted-foreground">{suggestion.address}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
