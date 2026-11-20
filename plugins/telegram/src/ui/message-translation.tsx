import { useTelegramLocale } from "./i18n/index.tsx";
import { ChevronDown, Languages } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ContextType } from "react";
import { translationLanguage, type MessageTranslation, type TranslationLanguage } from "../core/contract.ts";
import { RichMessage } from "./rich-message.tsx";
import { MessageText } from "./message-text.tsx";

export type TranslateMessage = (chatId: string, messageId: string, language: TranslationLanguage) => Promise<MessageTranslation | null>;
export const TranslationDefault = createContext<TranslationLanguage | undefined>(undefined);
export const TranslateMessageService = createContext<TranslateMessage | undefined>(undefined);

const display = new Intl.DisplayNames(["en"], { type: "language" });
export const translationLanguages = translationLanguage.options.map((value) => ({ value, label: display.of(value) ?? value }))
  .sort((a, b) => a.label.localeCompare(b.label, "en"));

export const ConversationTranslation = createContext<{
  chatId: string;
  language: TranslationLanguage;
  schedule: ReturnType<typeof createTranslationQueue>;
} | undefined>(undefined);

export function createTranslationQueue(translate: TranslateMessage, chatId: string, language: TranslationLanguage) {
  let running = 0;
  const queue = new Set<() => void>();

  return (messageId: string, done: (result: MessageTranslation | null) => void) => {
    let cancelled = false;
    let started = false;
    function run() {
      running++;
      void Promise.resolve().then(() => {
        if (cancelled) return null;
        started = true;
        return translate(chatId, messageId, language);
      })
        .then((result) => { if (!cancelled) done(result); }, () => { if (!cancelled) done(null); })
        .finally(() => {
          running--;
          const next = queue.values().next().value;
          if (!next) return;
          queue.delete(next);
          next();
        });
    }
    if (running < 3) run();
    else queue.add(run);
    return (queuedOnly = false) => {
      if (queuedOnly && started) return false;
      cancelled = true;
      queue.delete(run);
      return true;
    };
  };
}

function TranslatedContent({ result, language, chatId, messageId }: {
  result: MessageTranslation; language: TranslationLanguage; chatId: string; messageId: string;
}) {
  const { t: tr } = useTelegramLocale();
  return <div className="mtg-translated-text" lang={language} aria-label={tr("Telegram translation")}>
    {result.rich ? <RichMessage layout={result.rich} chatId={chatId} messageId={messageId} />
      : <MessageText text={result.text} links={result.links} styles={result.styles} />}
  </div>;
}

function VisibleTranslation({ messageId, scope }: {
  messageId: string;
  scope: NonNullable<ContextType<typeof ConversationTranslation>>;
}) {
  const { t: tr } = useTelegramLocale();
  const marker = useRef<HTMLDivElement>(null);
  const pending = useRef<ReturnType<typeof scope.schedule> | undefined>(undefined);
  const [result, setResult] = useState<MessageTranslation | null>();
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    const node = marker.current;
    if (!node || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.at(-1)?.isIntersecting;
      if (visible === false && pending.current?.(true)) pending.current = undefined;
      if (!visible || pending.current) return;
      pending.current = scope.schedule(messageId, (value) => {
        pending.current = undefined;
        observer.disconnect();
        setResult(value);
      });
    });
    observer.observe(node.closest("li") ?? node);
    return () => {
      observer.disconnect();
      pending.current?.();
      pending.current = undefined;
    };
  }, [messageId, scope]);

  function retry() {
    if (pending.current) return;
    setRetrying(true);
    pending.current = scope.schedule(messageId, (value) => {
      pending.current = undefined;
      setResult(value);
      setRetrying(false);
    });
  }

  return <div ref={marker}>
    {result && <TranslatedContent result={result} language={scope.language} chatId={scope.chatId} messageId={messageId} />}
    {result === null && <button type="button" className="mtg-reply-action" disabled={retrying} onClick={retry}>
      {retrying ? tr("Translating…") : tr("Retry translation")}
    </button>}
  </div>;
}

export function MessageTranslationControl({ chatId, messageId }: { chatId: string; messageId: string }) {
  const scope = useContext(ConversationTranslation);
  if (scope?.chatId === chatId) return <VisibleTranslation key={scope.language} messageId={messageId} scope={scope} />;
  return <ManualTranslation chatId={chatId} messageId={messageId} />;
}

function ManualTranslation({ chatId, messageId }: { chatId: string; messageId: string }) {
  const { locale, t: tr } = useTelegramLocale();
  const translate = useContext(TranslateMessageService);
  const [open, setOpen] = useState(false);
  const [override, setOverride] = useState<TranslationLanguage>();
  const [completed, setCompleted] = useState<{ language: TranslationLanguage; result: MessageTranslation | null }>();
  const defaultLanguage = useContext(TranslationDefault);
  const language = override ?? defaultLanguage ?? locale;
  const result = completed?.language === language ? completed.result : undefined;

  useEffect(() => {
    if (!translate || !open || result !== undefined) return;
    let cancelled = false;
    const complete = (value: MessageTranslation | null) => {
      if (!cancelled) setCompleted({ language, result: value });
    };
    void Promise.resolve().then(() => cancelled ? null : translate(chatId, messageId, language))
      .then(complete, () => complete(null));
    return () => { cancelled = true; };
  }, [translate, open, result, chatId, messageId, language]);

  if (!translate) return null;

  return <div className="mtg-message-translation">
    <div className="mtg-message-translation-actions">
      <button type="button" className="mtg-reply-action" aria-expanded={open} onClick={() => {
        if (!open && result === null) setCompleted(undefined);
        setOpen(!open);
      }}>
        <Languages size={15} aria-hidden="true" /> {open ? tr("Hide translation") : tr("Translate")}
      </button>
      <label className="mtg-translation-language" title={tr("Translation language")}>
        <span aria-hidden="true">{language.toUpperCase()}</span><ChevronDown size={12} aria-hidden="true" />
        <select aria-label={tr("Translation language")} value={override ?? ""} onChange={(event) => {
          setOverride(translationLanguage.safeParse(event.currentTarget.value).data);
          setCompleted(undefined);
          setOpen(true);
        }}>
          <option value="">{tr("Default translation language ({0})", [locale.toUpperCase()])}</option>
          {translationLanguages.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
    </div>
    {open && <div>
      {result === undefined && <p role="status">{tr("Translating with Telegram…")}</p>}
      {result === null && <>
        <p role="alert">{tr("Telegram translation is unavailable for this message.")}</p>
        <button type="button" className="mtg-reply-action" onClick={() => setCompleted(undefined)}>{tr("Retry translation")}</button>
      </>}
      {result && <TranslatedContent result={result} language={language} chatId={chatId} messageId={messageId} />}
    </div>}
  </div>;
}
