const LABELS: Record<string, string> = {
  running: "работает",
  ready: "работает",
  disabled: "выключен",
  idle: "простаивает",
  "needs approval": "нужно одобрение",
  "needs auth": "нужен вход",
  error: "ошибка",
};

/** The bridge spells statuses with spaces, hyphens or underscores; the label is Russian, an unknown status shows as sent. */
export function normaliseStatus(status: string): string {
  return status.trim().toLowerCase().replace(/[-_]+/g, " ");
}

export function statusLabel(status: string): string {
  return LABELS[normaliseStatus(status)] ?? status;
}
