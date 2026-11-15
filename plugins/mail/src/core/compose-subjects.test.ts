import { describe, expect, it } from "vitest";
import {
  FORWARD_MARKERS,
  REPLY_MARKERS,
  forwardSubject,
  replySubject,
} from "./compose-subjects.ts";
import { normalizeSubject } from "./threading.ts";

describe("marker lists", () => {
  it("names the reply and forward markers", () => {
    expect(REPLY_MARKERS).toEqual([
      "Re", "RE", "Aw", "AW", "Sv", "Antw", "Odp", "Rif", "R", "Vs", "VS", "Ответ", "Отв",
    ]);
    expect(FORWARD_MARKERS).toEqual(["Fwd", "Fw", "FW", "WG", "TR", "Pd", "Пересл"]);
  });
});

describe("replySubject", () => {
  it.each(REPLY_MARKERS.map((marker) => [`${marker}: Garden plans`]))(
    "strips the reply marker of %j",
    (subject) => {
      expect(replySubject(subject)).toBe("Re: Garden plans");
    },
  );

  it.each([
    ["Garden plans", "Re: Garden plans"],
    ["  Garden plans  ", "Re: Garden plans"],
    ["Re: Re: Garden plans", "Re: Garden plans"],
    ["Re: AW: Sv: Garden plans", "Re: Garden plans"],
    ["Re: Re[2]: Garden plans", "Re: Garden plans"],
    ["Re[3]: Garden plans", "Re: Garden plans"],
    ["Re(2): Garden plans", "Re: Garden plans"],
    ["RE : Garden plans", "Re: Garden plans"],
    ["re:Garden plans", "Re: Garden plans"],
    ["Re：Garden plans", "Re: Garden plans"],
    ["Ответ: Отв: Сад", "Re: Сад"],
    ["ОТВЕТ: Сад", "Re: Сад"],
    ["Fwd: Garden plans", "Re: Fwd: Garden plans"],
    ["Re: Fwd: Garden plans", "Re: Fwd: Garden plans"],
    ["Re: Fwd: Re: Garden plans", "Re: Fwd: Re: Garden plans"],
    ["Revenue report", "Re: Revenue report"],
    ["Rescheduled", "Re: Rescheduled"],
    ["Re Garden", "Re: Re Garden"],
    ["Garden Re: plans", "Re: Garden Re: plans"],
    ["", "Re:"],
    ["Re:", "Re:"],
  ])("%j → %j", (subject, expected) => {
    expect(replySubject(subject)).toBe(expected);
  });

  it("never carries a line break or control character into the header", () => {
    expect(replySubject("Garden\r\nBcc: eve@example.net")).toBe("Re: Garden Bcc: eve@example.net");
    expect(replySubject("Gar\u0000den")).toBe("Re: Gar den");
  });
});

describe("forwardSubject", () => {
  it.each(FORWARD_MARKERS.map((marker) => [`${marker}: Garden plans`]))(
    "strips the forward marker of %j",
    (subject) => {
      expect(forwardSubject(subject)).toBe("Fwd: Garden plans");
    },
  );

  it.each([
    ["Garden plans", "Fwd: Garden plans"],
    ["Fwd: Fw: WG: Garden plans", "Fwd: Garden plans"],
    ["Fwd[2]: Garden plans", "Fwd: Garden plans"],
    ["FW：Garden plans", "Fwd: Garden plans"],
    ["Пересл: Сад", "Fwd: Сад"],
    ["Re: Garden plans", "Fwd: Re: Garden plans"],
    ["Fwd: Re: Garden plans", "Fwd: Re: Garden plans"],
    ["TRaining day", "Fwd: TRaining day"],
    ["", "Fwd:"],
  ])("%j → %j", (subject, expected) => {
    expect(forwardSubject(subject)).toBe(expected);
  });
});

describe("normalizeSubject stays as it was", () => {
  it("still strips only its own prefixes, so existing threads do not regroup", () => {
    expect(normalizeSubject("Re: Fwd: Fw: Ответ: RE:  Garden Plans ")).toBe("garden plans");
    expect(normalizeSubject("AW: Garden")).toBe("aw: garden");
    expect(normalizeSubject("Re[2]: Garden")).toBe("re[2]: garden");
  });
});
