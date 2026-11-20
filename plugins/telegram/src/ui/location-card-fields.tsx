import { useTelegramLocale } from "./i18n/index.tsx";
import { locationPoint, quickReplyVenue } from "../core/contract.ts";

export type LocationCardFieldsValue = { latitude: string; longitude: string; title: string; address: string };

export function parseLocationCardFields(draft: LocationCardFieldsValue) {
  if (!draft.latitude.trim() || !draft.longitude.trim()) return;
  const point = locationPoint.safeParse({ latitude: Number(draft.latitude), longitude: Number(draft.longitude) }).data;
  if (!point) return;
  if (!draft.title.trim() && !draft.address.trim()) return { point };
  const venue = quickReplyVenue.safeParse(draft).data;
  if (venue) return { point, venue };
}

export function LocationCardFields({ draft, update }: { draft: LocationCardFieldsValue; update: (value: LocationCardFieldsValue) => void }) {
  const { t: tr } = useTelegramLocale();
  const hasVenue = !!(draft.title.trim() || draft.address.trim());
  return <>
    <label>{tr("Latitude ")}<input type="number" min={-90} max={90} step="any" value={draft.latitude}
      onChange={(event) => update({ ...draft, latitude: event.currentTarget.value })} /></label>
    <label>{tr("Longitude ")}<input type="number" min={-180} max={180} step="any" value={draft.longitude}
      onChange={(event) => update({ ...draft, longitude: event.currentTarget.value })} /></label>
    <label>{tr("Place name ")}<input maxLength={256} value={draft.title} required={hasVenue}
      onChange={(event) => update({ ...draft, title: event.currentTarget.value })} /></label>
    <label>{tr("Place address ")}<input maxLength={512} value={draft.address} required={hasVenue}
      onChange={(event) => update({ ...draft, address: event.currentTarget.value })} /></label>
  </>;
}
