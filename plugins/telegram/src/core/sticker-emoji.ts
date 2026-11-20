const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiMark = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u20e3/u;
const emojiCharacters = /^[\p{Emoji}\p{Extended_Pictographic}\u200d\ufe0f\u20e3\u{e0020}-\u{e007f}]+$/u;

export function stickerEmojiInput(text: string) {
  return Array.from(graphemes.segment(text), ({ segment }) => segment).filter((segment) => segment.trim());
}

export function isStickerEmoji(value: string) {
  return emojiMark.test(value) && emojiCharacters.test(value) && stickerEmojiInput(value).length === 1;
}

export function stickerEmojiKey(value: string) {
  return value.replaceAll("\ufe0f", "");
}

export function sameStickerEmojis(a: readonly string[], b: readonly string[]) {
  const keys = new Set(a.map(stickerEmojiKey));
  return a.length === b.length && b.every((emoji) => keys.has(stickerEmojiKey(emoji)));
}
