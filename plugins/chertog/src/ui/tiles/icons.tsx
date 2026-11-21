// The five glyphs of the tile chrome, drawn in the current text colour.
import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const CloseIcon = () => (
  <Icon>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

export const MoreIcon = () => (
  <Icon>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.5" />
  </Icon>
);

export const MaximizeIcon = () => (
  <Icon>
    <rect x="3" y="3" width="10" height="10" rx="1.5" />
  </Icon>
);

export const RestoreIcon = () => (
  <Icon>
    <rect x="3" y="5.5" width="7.5" height="7.5" rx="1.5" />
    <path d="M6 3h5.5A1.5 1.5 0 0 1 13 4.5V10" />
  </Icon>
);
