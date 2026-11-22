// Browser DOM regression used by stage-b-probe.mjs on the isolated BB stand.
import assert from "node:assert/strict";

export async function verifySelectArrow(select, key, expectedIndex) {
  await select.focus();
  const previous = await select.inputValue();
  const observed = await select.evaluateHandle(element => {
    const result = { prevented: null };
    element.ownerDocument.addEventListener("keydown", event => {
      result.prevented = event.defaultPrevented;
    }, { once: true });
    return result;
  });
  await select.press(key);
  assert.equal((await observed.jsonValue()).prevented, false, key + " was intercepted");
  await observed.dispose();
  assert.ok(await select.evaluate(element => element === document.activeElement), key + " moved focus");

  if (await select.inputValue() === previous) {
    // A closed macOS select requests a system popup. Headless-shell cannot
    // drive that popup. Expand the same DOM select for native list navigation.
    const size = await select.evaluate(element => {
      const original = element.size;
      element.size = Math.max(2, Math.min(element.options.length, 4));
      return original;
    });
    try {
      await select.press(key);
      assert.ok(await select.evaluate(element => element === document.activeElement), key + " moved focus");
    } finally {
      await select.evaluate((element, original) => { element.size = original; }, size);
    }
  }
  assert.equal(await select.evaluate(element => element.selectedIndex), expectedIndex);
  assert.notEqual(await select.inputValue(), previous);
}
