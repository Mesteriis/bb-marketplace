import { useTelegramLocale } from "./i18n/index.tsx";
import { MapPin } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { openStreetMapLink } from "../core/message-links.ts";
import { defaultMapPreviewDimensions, type LocationPoint, type MapPreviewDimensions, type MessageLocation } from "../core/contract.ts";

export type LoadLocationMap = (chatId: string, messageId: string) => Promise<string>;
export const LocationMapLoader = createContext<LoadLocationMap | undefined>(undefined);

export function LocationCard({ location, chatId, messageId, previewAllowed }: {
  location: MessageLocation;
  chatId: string;
  messageId: string;
  previewAllowed: boolean;
}) {
  const { locale: uiLocale, t: tr } = useTelegramLocale();
  const { latitude, longitude, place, liveUntil, canOpenMap } = location;
  const loadMap = useContext(LocationMapLoader);
  const loadPreview = useCallback(() => loadMap!(chatId, messageId), [loadMap, chatId, messageId]);
  const [now, setNow] = useState(Date.now);
  const deadline = typeof liveUntil === "number" ? liveUntil * 1000 : undefined;
  const active = liveUntil === "indefinite" || (deadline !== undefined && deadline > now);
  useEffect(() => {
    if (deadline === undefined || deadline <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(2147483647, deadline - Date.now())));
    return () => clearTimeout(timer);
  }, [deadline, now]);

  const date = deadline === undefined ? undefined : new Date(deadline);
  const coordinates = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  return <div className="mtg-location">
    <MapPin size={18} aria-hidden="true" />
    <div>
      <strong><bdi>{place?.title || (liveUntil === undefined ? tr("Location") : tr("Live location"))}</bdi></strong>
      {place?.address && <p><bdi>{place.address}</bdi></p>}
      <p><bdi>{coordinates}</bdi></p>
      {liveUntil !== undefined && <p>{active
        ? (date ? <>{tr("Sharing until ")}<time dateTime={date.toISOString()}>{date.toLocaleString(uiLocale)}</time></> : tr("Sharing live"))
        : tr("Live sharing ended")}</p>}
      {canOpenMap && <MapControls point={location} load={loadMap && previewAllowed ? loadPreview : undefined} />}
    </div>
  </div>;
}

export function MapControls({ point, zoom = 16, dimensions = defaultMapPreviewDimensions, load }: {
  point: LocationPoint; zoom?: number; dimensions?: MapPreviewDimensions; load?: () => Promise<string>;
}) {
  const { t: tr } = useTelegramLocale();
  const [mapOpen, setMapOpen] = useState(false);
  const { latitude, longitude } = point;
  const map = openStreetMapLink(point, zoom);
  return <>
    <div className="mtg-location-actions">
      {load && <button type="button" className="mtg-action" aria-expanded={mapOpen} onClick={() => setMapOpen(!mapOpen)}>
        {mapOpen ? tr("Hide map preview") : tr("Show map preview")}
      </button>}
      <a href={map} target="_blank" rel="noopener noreferrer">{tr("Open map")}</a>
    </div>
    {mapOpen && load && <MapPreview key={`${latitude}:${longitude}:${zoom}:${dimensions.width}:${dimensions.height}`}
      load={load} dimensions={dimensions} />}
  </>;
}

function MapPreview({ load, dimensions: { width, height } }: { load: () => Promise<string>; dimensions: MapPreviewDimensions }) {
  const { t: tr } = useTelegramLocale();
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void load().then(
      (base64) => { if (active) setSource(`data:image/png;base64,${base64}`); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [load, retry]);
  if (failed) return <div>
    <p role="status">{tr("Map preview unavailable.")}</p>
    <button type="button" className="mtg-action" onClick={() => {
      setSource(undefined);
      setFailed(false);
      setRetry((value) => value + 1);
    }}>{tr("Retry map preview")}</button>
  </div>;
  if (!source) return <p role="status">{tr("Loading map preview…")}</p>;
  return <div className="mtg-location-map" style={{ width }}>
    <img src={source} alt={tr("Map centered on the shared location")} width={width} height={height} onError={() => setFailed(true)} />
    <MapPin size={24} aria-hidden="true" />
  </div>;
}
