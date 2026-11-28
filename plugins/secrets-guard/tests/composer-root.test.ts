// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { findComposerRoot } from "../src/ui/composer-root.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  const lock = document.querySelector<HTMLElement>("#lock");
  if (lock === null) throw new Error("the fixture has no #lock");
  return lock;
}

describe("findComposerRoot", () => {
  it("is the closest ancestor that holds both the button and a textarea", () => {
    const lock = mount(`
      <main id="main">
        <div id="composer">
          <div id="editor-row"><textarea></textarea></div>
          <div id="toolbar"><span><button id="lock"></button></span><button>send</button></div>
        </div>
        <div id="footer">Personal workspace</div>
      </main>`);
    expect(findComposerRoot(lock)?.id).toBe("composer");
  });
  it("accepts a contenteditable editor", () => {
    const lock = mount(`
      <div id="outer"><div id="composer">
        <div contenteditable="true"></div>
        <div><button id="lock"></button></div>
      </div></div>`);
    expect(findComposerRoot(lock)?.id).toBe("composer");
  });
  it("does not take a contenteditable=false element for an editor", () => {
    const lock = mount(`
      <div id="outer">
        <div id="composer"><textarea></textarea>
          <div id="toolbar"><div contenteditable="false"></div><button id="lock"></button></div>
        </div>
      </div>`);
    expect(findComposerRoot(lock)?.id).toBe("composer");
  });
  it("is null when no ancestor holds an editor", () => {
    const lock = mount(`<div id="toolbar"><button id="lock"></button></div>`);
    expect(findComposerRoot(lock)).toBeNull();
  });
  it("is null when the only editor is somewhere else on the page", () => {
    const lock = mount(`
      <aside><textarea></textarea></aside>
      <div id="toolbar"><button id="lock"></button></div>`);
    expect(findComposerRoot(lock)).toBeNull();
  });
  it("is null for a missing button", () => {
    expect(findComposerRoot(null)).toBeNull();
  });
});
