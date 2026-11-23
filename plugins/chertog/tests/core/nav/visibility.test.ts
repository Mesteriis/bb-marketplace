import { describe, expect, it } from "vitest";
import { decideNavVisibility, type ItemState, type NavVisibilityDecision } from "../../../src/core/nav/index.ts";

type Stored = boolean | null;
type Delivered = boolean | null; // null: settings not delivered

const none: NavVisibilityDecision = { setVisible: null, store: null };
const stored: Stored[] = [null, true, false];
const delivered: Delivered[] = [null, true, false];
const items: ItemState[] = ["visible", "hidden", "missing"];

function expectedFor(s: Stored, d: Delivered, item: ItemState): NavVisibilityDecision {
  if (d === null) return none; // not delivered: do nothing
  if (item === "missing") return none; // nothing to act on yet; retry when it appears
  if (s === d) return none; // no transition
  if (s === null && d === true) return { setVisible: null, store: true }; // first run, on: leave the owner's choice
  const wanted = d;
  return { setVisible: (item === "visible") === wanted ? null : wanted, store: d };
}

describe("decideNavVisibility", () => {
  for (const s of stored)
    for (const d of delivered)
      for (const item of items)
        it(`stored ${s}, delivered ${d}, item ${item}`, () => {
          expect(decideNavVisibility({ stored: s, delivered: d, item })).toEqual(expectedFor(s, d, item));
        });

  it("spot checks", () => {
    expect(decideNavVisibility({ stored: null, delivered: false, item: "visible" })).toEqual({ setVisible: false, store: false });
    expect(decideNavVisibility({ stored: null, delivered: true, item: "hidden" })).toEqual({ setVisible: null, store: true });
    expect(decideNavVisibility({ stored: false, delivered: true, item: "hidden" })).toEqual({ setVisible: true, store: true });
    expect(decideNavVisibility({ stored: true, delivered: false, item: "hidden" })).toEqual({ setVisible: null, store: false });
  });
});
