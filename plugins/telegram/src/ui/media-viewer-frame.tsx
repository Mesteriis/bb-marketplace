import { ArrowLeft, ArrowRight, Info, X } from "lucide-react";
import { useId, useState, type ReactNode, type Ref } from "react";
import { useTelegramLocale } from "./i18n/index.tsx";

export function MediaViewerLoading({ label, poster, compact }: { label: string; poster?: string; compact?: boolean }) {
  return <div className="mtg-viewer-loading" data-compact={compact || undefined}>
    {poster && <img src={poster} alt="" />}
    <div className="mtg-viewer-loading-indicator" role="status">
      <span className="mtg-startup-track" aria-hidden="true"><span /></span>
      <span>{label}</span>
    </div>
  </div>;
}

export function MediaViewerFrame({ close, closeLabel, closeRef, title, counter, previous, next, actions, details, detailsInitiallyOpen = true, children }: {
  close: () => void;
  closeLabel: string;
  closeRef?: Ref<HTMLButtonElement>;
  title?: ReactNode;
  counter?: ReactNode;
  previous?: () => void;
  next?: () => void;
  actions?: ReactNode;
  details?: ReactNode;
  detailsInitiallyOpen?: boolean;
  children: ReactNode;
}) {
  const { t: tr } = useTelegramLocale();
  const [showDetails, setShowDetails] = useState(detailsInitiallyOpen);
  const detailsId = useId();
  return <>
    <header className="mtg-viewer-toolbar">
      {title && <div className="mtg-viewer-title">{title}</div>}
      {counter && <div className="mtg-viewer-counter">
        <button type="button" className="mtg-viewer-counter-arrow" aria-hidden="true" tabIndex={-1} disabled={!previous}
          title={tr("Previous photo")} onMouseDown={(event) => event.preventDefault()} onClick={previous}><ArrowLeft size={16} /></button>
        <span role="status">{counter}</span>
        <button type="button" className="mtg-viewer-counter-arrow" aria-hidden="true" tabIndex={-1} disabled={!next}
          title={tr("Next photo")} onMouseDown={(event) => event.preventDefault()} onClick={next}><ArrowRight size={16} /></button>
      </div>}
      <div className="mtg-viewer-actions">
        {actions}
        {details && <button type="button" className="mtg-photo-icon-button" aria-label={tr("Details")} title={tr("Details")}
          aria-controls={detailsId} aria-expanded={showDetails} onClick={() => setShowDetails((visible) => !visible)}>
          <Info size={18} aria-hidden="true" />
        </button>}
        <button ref={closeRef} type="button" className="mtg-photo-icon-button" aria-label={closeLabel} title={closeLabel} onClick={close}>
          <X size={19} aria-hidden="true" />
        </button>
      </div>
    </header>
    <div className="mtg-viewer-body">
      <div className="mtg-viewer-stage">{children}</div>
      {details && <aside id={detailsId} className="mtg-viewer-details" aria-label={tr("Details")} hidden={!showDetails}>{details}</aside>}
    </div>
  </>;
}
