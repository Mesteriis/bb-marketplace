// Which modifier keys the page has seen pressed and not yet released, so a view that loses focus (or a tab that hides) can send
// their key-up to the remote machine: otherwise Ctrl or Shift stays held in the guest while the owner is elsewhere.
const MODIFIER_KEYSYMS: Record<string, number> = {
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  MetaLeft: 0xffe7,
  MetaRight: 0xffe8,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  OSLeft: 0xffeb,
  OSRight: 0xffec,
};

export class ModifierTracker {
  private readonly held = new Set<string>();

  keyDown(code: string): void {
    if (code in MODIFIER_KEYSYMS) this.held.add(code);
  }

  keyUp(code: string): void {
    this.held.delete(code);
  }

  get pressed(): string[] {
    return [...this.held];
  }

  /** Sends a key-up for every modifier still held, and forgets them. */
  releaseAll(send: (keysym: number, code: string) => void): void {
    for (const code of this.held) send(MODIFIER_KEYSYMS[code] as number, code);
    this.held.clear();
  }
}
