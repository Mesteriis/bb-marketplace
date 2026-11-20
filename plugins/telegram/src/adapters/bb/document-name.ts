export function documentName(value: unknown, fallback = "Telegram document") {
  const cleaned = typeof value === "string"
    ? value.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}<>:"/\\|?*]/gu, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 180).replace(/[\p{Cs}]$/u, "")
    : "";
  return cleaned || fallback;
}
