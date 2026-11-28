import { describe, expect, it } from "vitest";
import {
  nextScope,
  openHeadline,
  pickScope,
  remainingLabel,
  remainingShare,
  scopeLabel,
  scopeShortLabel,
  statusLine,
} from "../src/ui/format.ts";

describe("remainingLabel", () => {
  it.each([
    [1600, 1000, "10 м"],
    [1061, 1000, "2 м"],
    [1060, 1000, "1 м"],
    [1030, 1000, "1 м"],
    [1001, 1000, "1 м"],
    [4600, 1000, "60 м"],
    [1000, 1000, ""],
    [999, 1000, ""],
  ])("until %i at %i is %j", (until, now, label) => {
    expect(remainingLabel(until, now)).toBe(label);
  });
});

describe("scopeLabel", () => {
  it("names the three scopes", () => {
    expect(scopeLabel("thread")).toBe("Этот чат");
    expect(scopeLabel("tree")).toBe("Этот чат и субтреды");
    expect(scopeLabel("global")).toBe("Глобально");
  });
});

describe("statusLine", () => {
  it("describes an open tree", () => {
    expect(
      statusLine(
        { configured: true, local: true, effective: { scope: "tree", until: 2440, rootThreadId: "a" } },
        1000,
      ),
    ).toBe("Открыто: этот чат и субтреды, осталось 24 мин");
  });
  it("describes an open thread and a global opening", () => {
    expect(
      statusLine(
        { configured: true, local: true, effective: { scope: "thread", until: 1600, rootThreadId: "a" } },
        1000,
      ),
    ).toBe("Открыто: этот чат, осталось 10 мин");
    expect(
      statusLine(
        { configured: true, local: true, effective: { scope: "global", until: 1061, rootThreadId: null } },
        1000,
      ),
    ).toBe("Открыто: глобально, осталось 2 мин");
  });
  it("asks for the setting when the marker location is missing", () => {
    expect(statusLine({ configured: false, local: true, effective: null }, 1000)).toBe(
      "Охрана не найдена: хук охраны Claude Code ещё не создал указатель. Запустите любой тред Claude Code или укажите файл отметки в настройках плагина",
    );
  });
  it("explains a thread on another machine", () => {
    expect(statusLine({ configured: true, local: false, effective: null }, 1000)).toBe(
      "Охрана настраивается только на этом Mac",
    );
  });
  it("says closed when nothing is open", () => {
    expect(statusLine({ configured: true, local: true, effective: null }, 1000)).toBe("Закрыто");
  });
  it("says closed once the deadline has passed, before the next poll", () => {
    expect(
      statusLine(
        { configured: true, local: true, effective: { scope: "thread", until: 1600, rootThreadId: "a" } },
        1600,
      ),
    ).toBe("Закрыто");
  });
});

describe("pickScope", () => {
  it("is this chat while nothing is open and nothing was chosen", () => {
    expect(pickScope(null, null)).toBe("thread");
  });
  it("follows the opening that arrives after the window was shown", () => {
    expect(pickScope(null, { scope: "global", until: 1600, rootThreadId: null })).toBe("global");
  });
  it("keeps the owner's own choice over what is open", () => {
    expect(pickScope("tree", { scope: "global", until: 1600, rootThreadId: null })).toBe("tree");
  });
});

describe("scopeShortLabel", () => {
  it("names the three segments", () => {
    expect(scopeShortLabel("thread")).toBe("Этот чат");
    expect(scopeShortLabel("tree")).toBe("С субтредами");
    expect(scopeShortLabel("global")).toBe("Глобально");
  });
});

describe("openHeadline", () => {
  it("says how long the guard stays open, rounded up", () => {
    expect(openHeadline(2440, 1000)).toBe("Открыто ещё 24 мин");
    expect(openHeadline(1061, 1000)).toBe("Открыто ещё 2 мин");
    expect(openHeadline(4600, 1000)).toBe("Открыто ещё 60 мин");
  });
});

describe("remainingShare", () => {
  it.each([
    [2440, 1000, 0.4],
    [1600, 1000, 1 / 6],
    [4600, 1000, 1],
    [2800, 1000, 0.5],
    [9999, 1000, 1],
    [1000, 1000, 0],
    [900, 1000, 0],
  ])("until %i at %i is %f of the longest term", (until, now, share) => {
    expect(remainingShare(until, now)).toBeCloseTo(share, 10);
  });
});

describe("nextScope", () => {
  it.each([
    ["thread", "ArrowRight", "tree"],
    ["tree", "ArrowRight", "global"],
    ["global", "ArrowRight", "thread"],
    ["thread", "ArrowLeft", "global"],
    ["tree", "ArrowLeft", "thread"],
    ["tree", "ArrowDown", "global"],
    ["tree", "ArrowUp", "thread"],
    ["tree", "Home", "thread"],
    ["tree", "End", "global"],
  ] as const)("from %s, %s goes to %s", (from, key, to) => {
    expect(nextScope(from, key)).toBe(to);
  });
  it("ignores other keys", () => {
    expect(nextScope("tree", "Enter")).toBeNull();
    expect(nextScope("tree", "a")).toBeNull();
  });
});
