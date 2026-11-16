import { useEffect, useState } from "react";
import type { TelegramDevice } from "../core/contract.ts";

export function TelegramDevices({ load, terminate }: {
  load: () => Promise<TelegramDevice[]>;
  terminate: (device: TelegramDevice) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<TelegramDevice[]>();
  const [confirm, setConfirm] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

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
    finally { setBusy(false); setConfirm(undefined); }
  }

  return <details onToggle={(event) => { setOpen(event.currentTarget.open); setConfirm(undefined); }}>
    <summary>Active devices</summary>
    {open && <>
      {!devices && !error && <p role="status">Loading devices…</p>}
      {devices && devices.length === 0 && <p>No Telegram devices returned.</p>}
      {!!devices?.length && <ul className="mtg-scheduled-list" aria-label="Telegram active devices">
        {devices.map((device) => <li key={device.id}>
          <bdi>{device.device || device.application || "Telegram device"}</bdi>
          {device.current && <> · This session</>}
          <p>{[device.application, device.platform].filter(Boolean).join(" · ")}
            {device.activeAt > 0 && <> · Active {new Date(device.activeAt * 1000).toLocaleString()}</>}</p>
          {!device.current && (confirm === device.id ? <>
            <p>Sign this device out of Telegram?</p>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => void remove(device)}>Confirm sign-out</button>
            <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(undefined)}>Keep session</button>
          </> : <button type="button" className="mtg-action" disabled={busy} onClick={() => setConfirm(device.id)}>Terminate session</button>)}
        </li>)}
      </ul>}
      <button type="button" className="mtg-action" disabled={busy} onClick={() => {
        setConfirm(undefined);
        setDevices(undefined);
        setNotice("");
        setRevision((value) => value + 1);
      }}>Refresh devices</button>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </>}
  </details>;
}
