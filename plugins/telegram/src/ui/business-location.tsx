import { useTelegramLocale } from "./i18n/index.tsx";
import { useRef, useState, type FormEvent } from "react";
import type { z } from "zod";
import { locationPoint, type schemas } from "../core/contract.ts";

type LocationView = z.infer<typeof schemas.businessLocation.output>;
type LocationChange = z.input<typeof schemas.saveBusinessLocation.input>;

export function BusinessLocationSettings({ read, save }: {
  read: () => Promise<LocationView>;
  save: (input: LocationChange) => Promise<z.infer<typeof schemas.saveBusinessLocation.output>>;
}) {
  const { t: tr } = useTelegramLocale();
  const pending = useRef(false);
  const [view, setView] = useState<LocationView>();
  const [address, setAddress] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const coordinates = !latitude.trim() && !longitude.trim() ? null : latitude.trim() && longitude.trim()
    ? locationPoint.safeParse({ latitude: Number(latitude), longitude: Number(longitude) }).data
    : undefined;
  const trimmed = address.trim();
  const invalid = !remove && (!trimmed || [...trimmed].length > 96 || coordinates === undefined);
  const changed = remove || trimmed !== view?.address
    || coordinates?.latitude !== view?.point?.latitude || coordinates?.longitude !== view?.point?.longitude;

  async function load() {
    const current = await read();
    setView(current);
    setAddress(current?.address ?? "");
    setLatitude(current?.point ? String(current.point.latitude) : "");
    setLongitude(current?.point ? String(current.point.longitude) : "");
    setRemove(false);
    setStale(false);
  }

  async function run(task: () => Promise<void>, failure: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try { await task(); }
    catch { setError(failure); }
    finally { pending.current = false; setBusy(false); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!view || stale || invalid || !changed) return;
    void run(async () => {
      const result = await save({ revision: view.revision, location: remove ? null : { address: trimmed, point: coordinates ?? null } });
      if (result === "saved") {
        setNotice(remove ? "Business address removed." : "Business address saved.");
        setStale(true);
        try { await load(); }
        catch { setError("Could not reload the address. Reload before editing again."); }
      } else if (result === "changed") {
        setStale(true);
        setError("The address changed in Telegram. Reload before editing.");
      } else setError("Telegram could not use this Business address.");
    }, "Could not confirm the Business address update.");
  }

  return <>
    <h3>{tr("Business address")}</h3>
    <button type="button" className="mtg-action" disabled={busy}
      onClick={() => void run(load, "Could not load the Business address.")}>{view === undefined ? tr("Load address") : tr("Reload address")}</button>
    {view === null && <p>{tr("The Business address is unavailable for this account.")}</p>}
    {view && <form onSubmit={submit}>
      <fieldset disabled={busy || stale || remove}>
        <label>{tr("Address ")}<input value={address} maxLength={384} onChange={(event) => setAddress(event.target.value)} /></label>
        <label>{tr("Latitude ")}<input type="number" min={-90} max={90} step="any" value={latitude}
          onChange={(event) => setLatitude(event.target.value)} /></label>
        <label>{tr("Longitude ")}<input type="number" min={-180} max={180} step="any" value={longitude}
          onChange={(event) => setLongitude(event.target.value)} /></label>
        <p>{tr("Leave both coordinates blank for an address without a map pin.")}</p>
      </fieldset>
      {!remove && coordinates === undefined && <p role="alert">{tr("Enter a valid latitude and longitude.")}</p>}
      {!remove && [...trimmed].length > 96 && <p role="alert">{tr("Use up to 96 characters for the address.")}</p>}
      {view.address && <button type="button" className="mtg-action" disabled={busy || stale}
        onClick={() => setRemove((current) => !current)}>{remove ? tr("Keep address") : tr("Remove address")}</button>}
      {remove && <p>{tr("The address will be removed when you save.")}</p>}
      <button type="submit" className="mtg-action" disabled={busy || stale || invalid || !changed}>{tr("Save address")}</button>
    </form>}
    {busy && <p role="status">{tr("Updating address…")}</p>}
    {error && <p role="alert">{tr(error)}</p>}
    {notice && <p role="status">{tr(notice)}</p>}
  </>;
}
