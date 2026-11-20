// A TON friendly address carries 34 bytes of payload followed by a big-endian
// CRC16-CCITT checksum. Keep the original workchain, bounce and network flags.
export function tonAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 96) return;
  const address = value.trim();
  const raw = /^(-?(?:0|[1-9][0-9]{0,9})):[a-f0-9]{64}$/i.exec(address);
  if (raw) {
    const workchain = Number(raw[1]);
    if (workchain >= -2147483648 && workchain <= 2147483647) return address;
    return;
  }
  if (!/^(?:[a-zA-Z0-9_-]{48}|[a-zA-Z0-9+/]{48})$/.test(address)) return;
  const bytes = atob(address.replaceAll("-", "+").replaceAll("_", "/"));
  const flags = bytes.charCodeAt(0) & 0x7f;
  if (flags !== 0x11 && flags !== 0x51) return;
  let checksum = 0;
  for (let i = 0; i < 34; i++) {
    checksum ^= bytes.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      checksum = ((checksum << 1) ^ (checksum & 0x8000 ? 0x1021 : 0)) & 0xffff;
    }
  }
  if (checksum === (bytes.charCodeAt(34) << 8 | bytes.charCodeAt(35))) return address;
}

export function telegramTonWalletLink(value: string) {
  const address = tonAddress(value);
  return address ? "tg://sendgrams?to=" + encodeURIComponent(address) : undefined;
}
