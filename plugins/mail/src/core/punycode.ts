// Punycode decoding (RFC 3492) for one domain label, written from the RFC
// for slice 3i: the core may not import a Node module, and the lookalike and
// mixed-alphabet checks need the Unicode form of an `xn--` label. Decoding
// only; bounded to 63 input characters, bad digits and overflow refused.

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const MAX_INT = 0x7fffffff;
/** Longest label decoded (a DNS label is at most 63 octets). */
const LABEL_MAX = 63;

function adapt(delta: number, points: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / points);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

/** The value of one basic code point as a digit; BASE when it is none. */
function digitOf(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 22; // 0-9 -> 26-35
  if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z -> 0-25
  if (code >= 0x61 && code <= 0x7a) return code - 0x61; // a-z -> 0-25
  return BASE;
}

/**
 * The Unicode text of one Punycode label (without its `xn--` prefix); null
 * for input over 63 characters, a non-ASCII character, a bad digit, a cut
 * integer, an overflow or a code point outside Unicode scalar values.
 */
export function decodePunycodeLabel(input: string): string | null {
  if (input.length > LABEL_MAX) return null;
  for (let i = 0; i < input.length; i += 1) if (input.charCodeAt(i) >= 0x80) return null;

  const delimiter = input.lastIndexOf("-");
  const output: number[] = [];
  for (let j = 0; j < Math.max(delimiter, 0); j += 1) output.push(input.charCodeAt(j));

  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  let index = delimiter > 0 ? delimiter + 1 : 0;
  while (index < input.length) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const digit = digitOf(input.charCodeAt(index));
      index += 1;
      if (digit >= BASE) return null;
      if (digit > Math.floor((MAX_INT - i) / w)) return null;
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) return null;
      w *= BASE - t;
    }
    const points = output.length + 1;
    bias = adapt(i - oldi, points, oldi === 0);
    if (Math.floor(i / points) > MAX_INT - n) return null;
    n += Math.floor(i / points);
    i %= points;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    output.splice(i, 0, n);
    i += 1;
  }
  return String.fromCodePoint(...output);
}

/**
 * A domain with every `xn--` label decoded, the rest lower-cased; null when
 * the domain is empty or a label does not decode.
 */
export function toUnicodeDomain(ascii: string): string | null {
  const domain = ascii.trim().replace(/\.$/, "");
  if (domain === "" || domain.length > 253) return null;
  const labels: string[] = [];
  for (const label of domain.split(".")) {
    if (/^xn--/i.test(label)) {
      const decoded = decodePunycodeLabel(label.slice(4));
      if (decoded === null || decoded === "") return null;
      labels.push(decoded.toLowerCase());
    } else {
      labels.push(label.toLowerCase());
    }
  }
  return labels.join(".");
}
