import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useState } from "react";
import type { SaveAvatarResult, SecondaryAvatarPhoto } from "../core/contract.ts";
import { AvatarEditor } from "./avatar-editor.tsx";

export type SecondaryAvatarActions = {
  load: () => Promise<SecondaryAvatarPhoto | null>;
  save: (base64: string, expected: string | null) => Promise<SaveAvatarResult>;
  remove: (expected: string) => Promise<SaveAvatarResult>;
};

export function SecondaryAvatarEditor({ label, description, actions, disabled }: {
  label: "personal contact photo" | "public profile photo";
  description: string;
  actions: SecondaryAvatarActions;
  disabled?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [photo, setPhoto] = useState<SecondaryAvatarPhoto | null>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setPhoto(undefined);
    setLoadFailed(false);
    void actions.load().then((value) => { if (active) setPhoto(value); }, () => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, [actions, open, attempt]);

  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{label === "public profile photo" ? tr("Public profile photo") : tr("Personal contact photo")}</summary>
    {open && <>
      <p>{description}</p>
      {photo === undefined && !loadFailed && <p role="status">{tr("Loading ")}{label}…</p>}
      {photo === null && <p>{tr("The ")}{label}{tr(" is unavailable.")}</p>}
      {loadFailed && <p role="alert">{tr("Could not load the ")}{label}. <button type="button" className="mtg-action"
        onClick={() => setAttempt((value) => value + 1)}>{tr("Retry")}</button></p>}
      {photo && <>
        {photo.preview && <img className="mtg-chat-photo-preview" alt={tr("Current {0}", [label])}
          src={`data:${photo.preview.mime};base64,${photo.preview.base64}`} />}
        <AvatarEditor label={label} version={photo.version} disabled={disabled} canRemove={photo.version !== null}
          save={actions.save} remove={actions.remove}
          reload={async () => {
            const fresh = await actions.load();
            if (fresh) setPhoto(fresh);
            return { version: fresh?.version, canRemove: !!fresh?.version };
          }} />
      </>}
    </>}
  </details>;
}
