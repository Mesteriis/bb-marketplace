import { CommanderError } from "./errors.ts";

export type SearchName = { glob: string } | { regex: string };

export function compileName(pattern: SearchName, caseSensitive: boolean): (name: string) => boolean {
  if ("regex" in pattern) {
    const { regex } = pattern;
    if (regex.length > 256) throw new CommanderError("unsupported", "Unsafe search regex");
    // Only flat expressions with one repetition are supported. Disallow groups,
    // alternation, backreferences and counted repetitions before invoking RegExp.
    const tokens = regex.match(/\[\^?[^\[\]\\]+\]|\\[.*+?^$\[\](){|}\\]|[^\[\]\\(){}|]/gu);
    if (tokens?.join("") !== regex ||
        tokens.filter((token) => /^[*+?]$/.test(token)).length > 1) {
      throw new CommanderError("unsupported", "Unsafe search regex");
    }
    try {
      const matcher = new RegExp(regex, caseSensitive ? "u" : "iu");
      return (name) => matcher.test(name);
    } catch {
      throw new CommanderError("invalid_name", "Invalid search regex");
    }
  }

  const fold = (text: string) => caseSensitive ? text : text.normalize("NFC").toLowerCase();
  const mask = [...fold(pattern.glob)];
  return (name) => {
    const chars = [...fold(name)];
    let token = 0, index = 0, star = -1, retry = 0;
    while (index < chars.length) {
      if (mask[token] === "*") {
        star = token++;
        retry = index;
      } else if (mask[token] === "?" || mask[token] === chars[index]) {
        token++;
        index++;
      } else if (star >= 0) {
        token = star + 1;
        index = ++retry;
      } else return false;
    }
    while (mask[token] === "*") token++;
    return token === mask.length;
  };
}
