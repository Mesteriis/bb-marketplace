import { CommanderError } from "./errors.ts";
import { NameSegment } from "./path.ts";

export const NAME_SUFFIX_LIMIT = 100_000;

/**
 * Splits at the first dot that is not the leading character, so ".bashrc" has
 * no extension and "archive.tar.gz" keeps ".tar.gz" as its extension.
 * Works on text or on a binary string (one char per byte).
 */
function splitName(name: string): { base: string; ext: string } {
  const dot = name.indexOf(".", 1);
  return dot === -1 ? { base: name, ext: "" } : { base: name.slice(0, dot), ext: name.slice(dot) };
}

function toSegment(bytesOrText: string, original: NameSegment): NameSegment {
  if ("t" in original) return { t: bytesOrText };
  const decoded = tryDecodeUtf8(bytesOrText);
  return decoded === null ? { b: btoa(bytesOrText) } : { t: decoded };
}

function tryDecodeUtf8(binary: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

/**
 * The first free "base (n).ext" for n from 2 to limit. The caller checks the
 * original name; this function only produces suffixed candidates.
 */
export function nextFreeName(
  name: NameSegment,
  taken: (candidate: NameSegment) => boolean,
  limit: number = NAME_SUFFIX_LIMIT,
): NameSegment {
  const text = "t" in name ? name.t : atob(name.b);
  const { base, ext } = splitName(text);
  for (let n = 2; n <= limit; n++) {
    const candidate = toSegment(`${base} (${n})${ext}`, name);
    // A suffix can push a name past the schema limits (1024 characters, base64 length).
    if (!NameSegment.safeParse(candidate).success) {
      throw new CommanderError("invalid_name", "The suffixed name exceeds the name length limit");
    }
    if (!taken(candidate)) return candidate;
  }
  throw new CommanderError("limit_exceeded", "No free name within the suffix limit");
}
