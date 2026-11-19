import { describe, expect, it } from "vitest";
import { createSignInResume } from "./sign-in-resume.ts";

const T0 = Date.parse("2026-11-19T12:00:00.000Z");
const MIN = 60_000;

describe("createSignInResume", () => {
  it("tries at once, then 10 and 30 minutes after a refusal, then hourly", () => {
    const resume = createSignInResume();
    expect(resume.due("acc_1", "sealed-a", T0)).toBe(true);

    resume.failed("acc_1", "sealed-a", T0);
    expect(resume.due("acc_1", "sealed-a", T0 + 10 * MIN - 1)).toBe(false);
    expect(resume.due("acc_1", "sealed-a", T0 + 10 * MIN)).toBe(true);

    resume.failed("acc_1", "sealed-a", T0 + 10 * MIN);
    expect(resume.due("acc_1", "sealed-a", T0 + 40 * MIN - 1)).toBe(false);
    expect(resume.due("acc_1", "sealed-a", T0 + 40 * MIN)).toBe(true);

    resume.failed("acc_1", "sealed-a", T0 + 40 * MIN);
    expect(resume.due("acc_1", "sealed-a", T0 + 100 * MIN - 1)).toBe(false);
    expect(resume.due("acc_1", "sealed-a", T0 + 100 * MIN)).toBe(true);

    resume.failed("acc_1", "sealed-a", T0 + 100 * MIN);
    expect(resume.due("acc_1", "sealed-a", T0 + 160 * MIN - 1)).toBe(false);
    expect(resume.due("acc_1", "sealed-a", T0 + 160 * MIN)).toBe(true);
  });

  it("starts over for a new password, a cleared account and another account", () => {
    const resume = createSignInResume();
    resume.failed("acc_1", "sealed-a", T0);
    expect(resume.due("acc_1", "sealed-b", T0 + 1)).toBe(true);
    expect(resume.due("acc_2", "sealed-a", T0 + 1)).toBe(true);

    resume.failed("acc_1", "sealed-b", T0 + 1);
    expect(resume.due("acc_1", "sealed-b", T0 + 10 * MIN)).toBe(false);
    expect(resume.due("acc_1", "sealed-b", T0 + 10 * MIN + 1)).toBe(true);

    resume.clear("acc_1");
    expect(resume.due("acc_1", "sealed-b", T0 + 2)).toBe(true);
  });
});
