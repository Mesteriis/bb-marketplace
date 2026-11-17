// AI settings (slice 3c, titled so in 3f): which Makosh AI provider and model
// translate, into which language by default, and Clear translations. The
// provider and model lists come from Makosh AI through the server; there is
// no default provider or model in this code.
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { stopEscape } from "./shortcuts.ts";
import { TRANSLATE_LANGUAGES } from "./translation-block.tsx";
import { tx } from "./i18n/index.ts";

/** translate_settings_get's answer. */
export interface TranslateSettingsData {
  gateway: string;
  providers: { id: string; displayName: string; available: boolean; reason: string | null }[];
  /** The current provider's models; null or empty: type the model id. */
  models: { model: string; displayName: string }[] | null;
  current: { providerId: string; model: string; language: string };
}

export interface TranslationSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  load: () => Promise<TranslateSettingsData>;
  save: (input: { providerId: string; model: string; language: string }) => Promise<void>;
  /** translate_clear: how many were removed. */
  clear: () => Promise<number>;
  /** After a save. */
  onSaved?: () => void;
}

type Loaded = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: TranslateSettingsData };

export function TranslationSettings({ open, onOpenChange, load, save, clear, onSaved }: TranslationSettingsProps) {
  const id = useId();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [language, setLanguage] = useState("en");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoaded({ kind: "loading" });
    setNote(null);
    load().then(
      (data) => {
        if (!live) return;
        setLoaded({ kind: "ready", data });
        setProviderId(data.current.providerId);
        setModel(data.current.model);
        setLanguage(data.current.language);
      },
      () => {
        if (live) setLoaded({ kind: "error" });
      },
    );
    return () => {
      live = false;
    };
  }, [load, open]);

  const data = loaded.kind === "ready" ? loaded.data : null;
  const gatewayOk = data !== null && data.gateway === "ok";
  const chosen = data?.providers.find((p) => p.id === providerId) ?? null;
  // The listed models belong to the saved provider only.
  const models = data !== null && providerId === data.current.providerId && data.models !== null && data.models.length > 0
    ? data.models
    : null;

  const onSave = async () => {
    setBusy(true);
    setNote(null);
    try {
      await save({ providerId, model: model.trim(), language });
      onSaved?.();
      onOpenChange(false);
    } catch {
      setNote("Could not save the settings.");
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    setBusy(true);
    setNote(null);
    try {
      const removed = await clear();
      setNote(removed === 1 ? "Removed 1 stored translation." : `Removed ${removed} stored translations.`);
    } catch {
      setNote("Could not clear the translations.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" onEscapeKeyDown={stopEscape}>
        <DialogHeader>
          <DialogTitle>{tx("AI settings")}</DialogTitle>
          <DialogDescription>
            {tx("Translate sends the message's subject and text, never attachments or images, to the provider you choose in Makosh AI. Translations are kept on this computer until you clear them.")}
          </DialogDescription>
        </DialogHeader>
        {loaded.kind === "loading" ? <p className="text-sm text-muted-foreground">{tx("Loading\u2026")}</p> : null}
        {loaded.kind === "error" ? (
          <p role="alert" className="text-sm text-destructive">
            {tx("Could not load the translation settings.")}
          </p>
        ) : null}
        {data !== null && !gatewayOk ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {tx("Translation needs the Makosh AI plugin. Install or enable it in BB, then open these settings again.")}
          </p>
        ) : null}
        {data !== null && gatewayOk ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label id={`${id}-provider`} className="text-sm font-medium text-foreground">
                {tx("Provider")}
              </label>
              <Select value={providerId === "" ? undefined : providerId} onValueChange={setProviderId}>
                <SelectTrigger aria-labelledby={`${id}-provider`}>
                  <SelectValue placeholder={tx("Choose a provider")} />
                </SelectTrigger>
                <SelectContent>
                  {data.providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.available ? p.displayName : `${p.displayName} (not available)`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {chosen !== null && !chosen.available ? (
                <>
                  <p className="text-xs text-destructive">{tx("This provider is not available in Makosh AI right now.")}</p>
                  {chosen.reason !== null && chosen.reason !== "" ? (
                    <p className="text-xs text-muted-foreground">{tx("Makosh AI: {reason}", { reason: chosen.reason })}</p>
                  ) : null}
                </>
              ) : null}
              <p className="text-xs text-muted-foreground">{tx("Other providers need a Makosh Mail update.")}</p>
            </div>
            <div className="flex flex-col gap-1">
              <label id={`${id}-model`} htmlFor={`${id}-model-input`} className="text-sm font-medium text-foreground">
                {tx("Model")}
              </label>
              {models !== null ? (
                <Select value={model === "" ? undefined : model} onValueChange={setModel}>
                  <SelectTrigger aria-labelledby={`${id}-model`}>
                    <SelectValue placeholder={tx("Choose a model")} />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.model} value={m.model}>
                        {m.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <>
                  <Input
                    id={`${id}-model-input`}
                    value={model}
                    maxLength={200}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder={tx("Model id")}
                  />
                  <p className="text-xs text-muted-foreground">
                    {providerId !== data.current.providerId
                      ? tx("Save to see this provider's models; or type a model id.")
                      : tx("Makosh AI did not list models; type a model id.")}
                  </p>
                </>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label id={`${id}-language`} className="text-sm font-medium text-foreground">
                {tx("Translate into")}
              </label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger aria-labelledby={`${id}-language`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSLATE_LANGUAGES.map((l) => (
                    <SelectItem key={l.tag} value={l.tag}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : null}
        {note !== null ? <p role="status" className="text-sm text-muted-foreground">{note}</p> : null}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" size="sm" disabled={busy || data === null} onClick={() => void onClear()}>
            {tx("Clear translations")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {tx("Cancel")}
            </Button>
            <Button size="sm" disabled={busy || !gatewayOk} onClick={() => void onSave()}>
              {tx("Save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
