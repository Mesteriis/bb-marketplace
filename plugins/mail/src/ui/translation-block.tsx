// A machine translation of one message (slice 3c), shown under its header
// and above the message frame. The owner starts it; the text streams in
// from the server's translate_poll. A model wrote it, from a message that
// may try to steer it, so it is plain text only: a React text child in
// pre-wrap, never HTML, Markdown or a link, and never inside the frame.
import type { TranslateErrorKind } from "../core/translate.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { msg, tx } from "./i18n/index.ts";

/** The languages the server takes (SUPPORTED_LANGUAGES in the core), by tag. */
export const TRANSLATE_LANGUAGES: readonly { tag: string; label: string }[] = [
  { tag: "ru", label: msg("Russian") },
  { tag: "en", label: msg("English") },
  { tag: "de", label: msg("German") },
  { tag: "fr", label: msg("French") },
  { tag: "es", label: msg("Spanish") },
  { tag: "it", label: msg("Italian") },
  { tag: "pt", label: msg("Portuguese") },
  { tag: "uk", label: msg("Ukrainian") },
  { tag: "pl", label: msg("Polish") },
  { tag: "tr", label: msg("Turkish") },
  { tag: "zh", label: msg("Chinese") },
  { tag: "ja", label: msg("Japanese") },
  { tag: "ko", label: msg("Korean") },
  { tag: "ar", label: msg("Arabic") },
  { tag: "he", label: msg("Hebrew") },
];

export function languageLabel(tag: string): string {
  const known = TRANSLATE_LANGUAGES.find((l) => l.tag === tag)?.label;
  return known !== undefined ? tx(known) : tag;
}

export interface TranslationState {
  status: "starting" | "running" | "done" | "failed" | "cancelled";
  /** The target language tag. */
  language: string;
  /** Everything received so far. */
  text: string;
  provider: string | null;
  model: string | null;
  cached: boolean;
  /** Only the first part of a long message was translated. */
  truncatedInput: boolean;
  /** The output hit its limit. */
  cutShort: boolean;
  /** A stored translation that is not complete (either of the two above). */
  incomplete: boolean;
  error: TranslateErrorKind | null;
  /** makosh-ai's own refusal text (sanitized by the server); only with pool_unavailable. */
  gatewayMessage: string | null;
}

export const TRANSLATION_STARTING = (language: string): TranslationState => ({
  status: "starting",
  language,
  text: "",
  provider: null,
  model: null,
  cached: false,
  truncatedInput: false,
  cutShort: false,
  incomplete: false,
  error: null,
  gatewayMessage: null,
});

/** What the owner reads when a translation cannot be made (the spec's degradation table). */
export function translationErrorText(error: TranslateErrorKind, provider: string | null, model: string | null): string {
  const p = provider ?? "";
  const m = model ?? "";
  switch (error) {
    case "gateway_missing":
      return tx("Translation needs the Makosh AI plugin.");
    case "pool_unavailable":
      return tx("Makosh AI cannot reach Account Pooler right now.");
    case "provider_unknown":
      return tx("The translation provider '{p}' is not available in Makosh AI. Choose another in AI settings.", { p });
    case "model_unknown":
      return tx("The model '{m}' is not available for '{p}'. Choose another in AI settings.", { m, p });
    case "auth":
      return tx("The provider refused the request (sign-in). Try later or choose another provider.");
    case "quota":
      return tx("The provider refused the request (quota). Try later or choose another provider.");
    case "refused":
      return tx("The model declined to translate this message.");
    case "too_large":
      return tx("The message is too large to translate.");
    case "busy":
      return tx("Translation is busy; try again in a moment.");
    case "cancelled":
      return tx("The translation was stopped.");
    case "failed":
      return tx("The translation failed.");
  }
}

export interface TranslationBlockProps {
  state: TranslationState;
  onStop: () => void;
  /** Translate again (bypasses the cache); also Retry after a failure. */
  onAgain: () => void;
  onLanguage: (tag: string) => void;
  onSettings: () => void;
  languages?: readonly { tag: string; label: string }[];
}

export function TranslationBlock({
  state,
  onStop,
  onAgain,
  onLanguage,
  onSettings,
  languages = TRANSLATE_LANGUAGES,
}: TranslationBlockProps) {
  const running = state.status === "starting" || state.status === "running";
  const label = [
    "Machine translation",
    ...(state.provider !== null && state.provider !== "" ? [state.provider] : []),
    ...(state.model !== null && state.model !== "" ? [state.model] : []),
    `into ${languageLabel(state.language)}`,
    ...(state.cached ? ["cached"] : []),
  ].join(" · ");
  const failed = state.status === "failed" && state.error !== null;
  return (
    <section aria-label={tx("Translation")} className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="Languages" fallback="Mail" className="size-4 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">{label}</p>
        <Select value={state.language} onValueChange={onLanguage} disabled={running}>
          <SelectTrigger aria-label={tx("Translate into")} className="h-7 w-auto px-2 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {languages.map((l) => (
              <SelectItem key={l.tag} value={l.tag}>
                {tx(l.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {running ? (
          <Button variant="outline" size="sm" className="h-7 px-2" onClick={onStop}>
            {tx("Stop")}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onAgain}>
            {failed ? tx("Retry") : tx("Translate again")}
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onSettings}>
          {tx("AI settings\u2026")}
        </Button>
      </div>
      {running ? (
        <p role="status" className="text-xs text-muted-foreground">
          {tx("Translating\u2026")}
        </p>
      ) : null}
      {failed ? (
        <div role="alert" className="flex flex-col gap-0.5 text-xs text-destructive">
          <p>{translationErrorText(state.error!, state.provider, state.model)}</p>
          {state.gatewayMessage !== null && state.gatewayMessage !== "" ? (
            <p className="text-muted-foreground">{tx("Makosh AI says:")} {state.gatewayMessage}</p>
          ) : null}
        </div>
      ) : null}
      {state.status === "cancelled" ? (
        <p className="text-xs text-muted-foreground">{tx("The translation was stopped.")}</p>
      ) : null}
      {state.text !== "" ? (
        <div className={cn("whitespace-pre-wrap break-words text-sm text-foreground")}>{state.text}</div>
      ) : null}
      {state.truncatedInput ? (
        <p className="text-xs text-muted-foreground">{tx("Translated the first part of a long message.")}</p>
      ) : null}
      {state.cutShort ? <p className="text-xs text-muted-foreground">{tx("The translation was cut short.")}</p> : null}
      {state.incomplete && !state.truncatedInput && !state.cutShort ? (
        <p className="text-xs text-muted-foreground">{tx("This translation is not complete.")}</p>
      ) : null}
      {state.text !== "" ? (
        <p className="text-xs text-muted-foreground">{tx("Translated by a model; it may be wrong.")}</p>
      ) : null}
    </section>
  );
}
