import { useTelegramLocale } from "./i18n/index.tsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { sessionInactivityDays, type TelegramDevice } from "../core/contract.ts";

export type SessionInactivityActions = {
  load: () => Promise<number | null>;
  save: (days: number, expected: number) => Promise<"saved" | "changed" | "unavailable">;
};

type DeviceReview = { kind: "confirm" | "signOut"; id: string } | { kind: "signOutOthers" };

export function TelegramDevices({ load, terminate, approve, terminateOthers, inactivity, initialOpen = false }: {
  load: () => Promise<TelegramDevice[]>;
  terminate: (device: TelegramDevice) => Promise<boolean>;
  approve?: (id: string, revision: string) => Promise<"confirmed" | "changed" | "unavailable">;
  terminateOthers?: (expected: string[]) => Promise<"terminated" | "changed" | "unavailable">;
  inactivity?: SessionInactivityActions;
  initialOpen?: boolean;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(initialOpen);
  const summary = useRef<HTMLElement>(null);
  const [devices, setDevices] = useState<TelegramDevice[]>();
  const [review, setReview] = useState<DeviceReview>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    if (initialOpen) summary.current?.focus();
  }, [initialOpen]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError("");
    void load().then((result) => { if (current) setDevices(result); },
      () => { if (current) setError("Could not load Telegram devices."); });
    return () => { current = false; };
  }, [open, load, revision]);

  async function remove(device: TelegramDevice) {
    if (device.current || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!await terminate(device)) {
        setError("Telegram did not terminate this session. Refresh the list before retrying.");
        return;
      }
      setDevices((previous) => previous?.filter(({ id }) => id !== device.id));
      setNotice("Session terminated.");
    } catch { setError("Telegram could not terminate this session."); }
    finally { setBusy(false); setReview(undefined); }
  }

  async function accept(device: TelegramDevice) {
    if (!approve || !device.unconfirmed || device.current || device.passwordPending || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await approve(device.id, device.unconfirmed.revision);
      if (result === "changed" || result === "confirmed") {
        setDevices(undefined);
        setRevision((value) => value + 1);
        setNotice(result === "confirmed" ? "Telegram session confirmed." : "The session changed. Review the refreshed devices.");
      } else setError("Telegram did not confirm this session. Refresh the list before retrying.");
    } catch { setError("Could not confirm this session. Refresh the list to check its status."); }
    finally { setBusy(false); setReview(undefined); }
  }

  const others = devices?.filter(({ current }) => !current).map(({ id }) => id) ?? [];
  const canTerminateOthers = !!terminateOthers && others.length > 0 && devices?.filter(({ current }) => current).length === 1;

  async function removeOthers() {
    if (!canTerminateOthers || !terminateOthers || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await terminateOthers(others);
      if (result === "terminated") {
        setDevices((previous) => previous?.filter(({ current }) => current));
        setNotice("Other Telegram sessions signed out.");
      } else if (result === "changed") {
        setDevices(undefined);
        setRevision((value) => value + 1);
        setNotice("The device list changed. Review it before signing out.");
      } else setError("Telegram did not terminate the other sessions.");
    } catch {
      setError("Could not terminate the other sessions.");
    } finally {
      setBusy(false);
      setReview(undefined);
    }
  }

  return <details open={open} onToggle={(event) => {
    if (event.target !== event.currentTarget) return;
    setOpen(event.currentTarget.open);
    setReview(undefined);
  }}>
    <summary ref={summary}>{tr("Active devices")}</summary>
    {open && <>
      {!devices && !error && <p role="status">{tr("Loading devices…")}</p>}
      {devices && devices.length === 0 && <p>{tr("No Telegram devices returned.")}</p>}
      {!!devices?.length && <ul className="mtg-scheduled-list" aria-label={tr("Telegram active devices")}>
        {devices.map((device) => {
          const deviceReview = review && "id" in review && device.id === review.id ? review.kind : undefined;
          const canReview = approve && !device.current && !device.passwordPending && device.unconfirmed;
          return <li key={device.id}>
            <bdi>{device.device || device.application || tr("Telegram device")}</bdi>
            {device.current && <>{tr(" · This session")}</>}
            <p>{[device.application, device.platform].filter(Boolean).join(" · ")}
              {device.activeAt > 0 && <>{tr(" · Active ")}{new Date(device.activeAt * 1000).toLocaleString(uiLocale)}</>}</p>
            {device.passwordPending && <p>{tr("Waiting for the two-step verification password.")}</p>}
            {device.unconfirmed && <p>{tr("New sign-in awaiting confirmation.")}{device.unconfirmed.signedInAt > 0 && <>{tr(" · Signed in ")}{new Date(device.unconfirmed.signedInAt * 1000).toLocaleString(uiLocale)}</>}
              {device.unconfirmed.location && <> · <bdi>{device.unconfirmed.location}</bdi></>}
            </p>}
            {canReview && deviceReview === "confirm" && <div role="group" aria-label={tr("Confirm Telegram sign-in")}>
              <p>{tr("Recognize this device and its sign-in?")}</p>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => void accept(device)}>{tr("Confirm sign-in")}</button>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(undefined)}>{tr("Cancel")}</button>
            </div>}
            {canReview && !review && <button type="button" className="mtg-action" disabled={busy}
              onClick={() => setReview({ kind: "confirm", id: device.id })}>{tr("Review sign-in")}</button>}
            {!device.current && (deviceReview === "signOut" ? <>
              <p>{tr("Sign this device out of Telegram?")}</p>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => void remove(device)}>{tr("Confirm sign-out")}</button>
              <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(undefined)}>{tr("Keep session")}</button>
            </> : <button type="button" className="mtg-action" disabled={busy || !!review}
              onClick={() => setReview({ kind: "signOut", id: device.id })}>{tr("Terminate session")}</button>)}
          </li>;
        })}
      </ul>}
      {canTerminateOthers && (review?.kind === "signOutOthers" ? <div role="group" aria-label={tr("Confirm other session sign-out")}>
        <p>{tr("Sign out ")}{others.length}{tr(" other ")}{others.length === 1 ? tr("session") : tr("sessions")}?</p>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => void removeOthers()}>{tr("Confirm sign-out of other devices")}</button>
        <button type="button" className="mtg-action" disabled={busy} onClick={() => setReview(undefined)}>{tr("Keep other sessions")}</button>
      </div> : <button type="button" className="mtg-action" disabled={busy || !!review}
        onClick={() => setReview({ kind: "signOutOthers" })}>{tr("Terminate all other sessions")}</button>)}
      <button type="button" className="mtg-action" disabled={busy} onClick={() => {
        setReview(undefined);
        setDevices(undefined);
        setNotice("");
        setRevision((value) => value + 1);
      }}>{tr("Refresh devices")}</button>
      {notice && <p role="status">{tr(notice)}</p>}
      {error && <p role="alert">{tr(error)}</p>}
      {inactivity && <SessionInactivity actions={inactivity} />}
    </>}
  </details>;
}

function SessionInactivity({ actions }: { actions: SessionInactivityActions }) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<number | null>();
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const next = sessionInactivityDays.safeParse(Number(days));

  useEffect(() => {
    if (!open) return;
    let active = true;
    void actions.load().then((value) => {
      if (!active) return;
      setCurrent(value);
      setDays(value === null ? "" : String(value));
    }).catch(() => { if (active) setCurrent(null); });
    return () => { active = false; };
  }, [actions, open, revision]);

  return <details onToggle={(event) => {
    if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
  }}>
    <summary>{tr("Inactive sessions")}</summary>
    {open && current === undefined && <p role="status">{tr("Loading inactivity period…")}</p>}
    {open && current === null && <p role="status">{tr("Telegram did not provide an inactivity period.")}</p>}
    {open && typeof current === "number" && <form onSubmit={async (event) => {
      event.preventDefault();
      if (busy || !next.success || next.data === current) return;
      setBusy(true);
      setNotice("");
      try {
        const result = await actions.save(next.data, current);
        if (result === "saved") {
          setCurrent(next.data);
          setNotice("Inactivity period saved.");
        } else if (result === "changed") {
          setCurrent(undefined);
          setRevision((value) => value + 1);
          setNotice("Telegram changed the inactivity period. Loaded the current setting.");
        } else setNotice("Telegram did not save the inactivity period.");
      } catch {
        setNotice("Could not save the inactivity period.");
      } finally {
        setBusy(false);
      }
    }}>
      <label>{tr("Sign out devices after (days) ")}<input type="number" min={1} max={366} step={1}
        value={days} disabled={busy} onChange={(event) => setDays(event.currentTarget.value)} /></label>
      <button type="submit" className="mtg-action" disabled={busy || !next.success || next.data === current}>{tr("Save inactivity period")}</button>
    </form>}
    {open && notice && <p role="status">{tr(notice)}</p>}
  </details>;
}
