// Host-free mapping from a DOM KeyboardEvent.code to an RDP scancode
// (PC/XT set 1 make code) plus the extended (E0-prefix) flag. Only the US
// layout set the plugin supports is listed; an unknown code returns null so
// the caller falls back to unicode text input for printable keys.
export interface RdpKey {
  /**
   * PC/XT set 1 make code, without the E0 prefix: 0x01..0x58, plus 0x5B, 0x5C
   * and 0x5D for the extended Windows and context-menu keys. The helper's
   * `valid_key` accepts exactly this set.
   */
  scancode: number;
  /** True when the key must be sent with the 0xE0 extended prefix. */
  extended: boolean;
}

const plain = (scancode: number): [number, boolean] => [scancode, false];
const ext = (scancode: number): [number, boolean] => [scancode, true];

// Main-keyboard letters in QWERTY physical order (set 1).
const LETTERS: Record<string, [number, boolean]> = {
  KeyA: plain(0x1e),
  KeyB: plain(0x30),
  KeyC: plain(0x2e),
  KeyD: plain(0x20),
  KeyE: plain(0x12),
  KeyF: plain(0x21),
  KeyG: plain(0x22),
  KeyH: plain(0x23),
  KeyI: plain(0x17),
  KeyJ: plain(0x24),
  KeyK: plain(0x25),
  KeyL: plain(0x26),
  KeyM: plain(0x32),
  KeyN: plain(0x31),
  KeyO: plain(0x18),
  KeyP: plain(0x19),
  KeyQ: plain(0x10),
  KeyR: plain(0x13),
  KeyS: plain(0x1f),
  KeyT: plain(0x14),
  KeyU: plain(0x16),
  KeyV: plain(0x2f),
  KeyW: plain(0x11),
  KeyX: plain(0x2d),
  KeyY: plain(0x15),
  KeyZ: plain(0x2c),
};

const TABLE: Record<string, [number, boolean]> = {
  ...LETTERS,
  Escape: plain(0x01),
  Digit1: plain(0x02),
  Digit2: plain(0x03),
  Digit3: plain(0x04),
  Digit4: plain(0x05),
  Digit5: plain(0x06),
  Digit6: plain(0x07),
  Digit7: plain(0x08),
  Digit8: plain(0x09),
  Digit9: plain(0x0a),
  Digit0: plain(0x0b),
  Minus: plain(0x0c),
  Equal: plain(0x0d),
  Backspace: plain(0x0e),
  Tab: plain(0x0f),
  BracketLeft: plain(0x1a),
  BracketRight: plain(0x1b),
  Enter: plain(0x1c),
  ControlLeft: plain(0x1d),
  Semicolon: plain(0x27),
  Quote: plain(0x28),
  Backquote: plain(0x29),
  ShiftLeft: plain(0x2a),
  Backslash: plain(0x2b),
  Comma: plain(0x33),
  Period: plain(0x34),
  Slash: plain(0x35),
  ShiftRight: plain(0x36),
  AltLeft: plain(0x38),
  Space: plain(0x39),
  CapsLock: plain(0x3a),
  F1: plain(0x3b),
  F2: plain(0x3c),
  F3: plain(0x3d),
  F4: plain(0x3e),
  F5: plain(0x3f),
  F6: plain(0x40),
  F7: plain(0x41),
  F8: plain(0x42),
  F9: plain(0x43),
  F10: plain(0x44),
  F11: plain(0x57),
  F12: plain(0x58),

  // Extended (E0-prefix) keys.
  ControlRight: ext(0x1d),
  AltRight: ext(0x38),
  MetaLeft: ext(0x5b),
  MetaRight: ext(0x5c),
  Insert: ext(0x52),
  Delete: ext(0x53),
  Home: ext(0x47),
  End: ext(0x4f),
  PageUp: ext(0x49),
  PageDown: ext(0x51),
  ArrowUp: ext(0x48),
  ArrowLeft: ext(0x4b),
  ArrowRight: ext(0x4d),
  ArrowDown: ext(0x50),
  ContextMenu: ext(0x5d),
};

/** DOM KeyboardEvent.code -> scancode + extended flag, or null for unknown codes. */
export function codeToScancode(code: string): RdpKey | null {
  const entry = TABLE[code];
  if (entry === undefined) return null;
  return { scancode: entry[0], extended: entry[1] };
}
