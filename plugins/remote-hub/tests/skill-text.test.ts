import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skill = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "remote-hub", "SKILL.md"), "utf8");

describe("the agent skill text states the three desktop rules", () => {
  it("1: no launching shells or programs by input unless the owner asked; say what you will type", () => {
    expect(skill).toContain("Do NOT start shells or programs through Start, Run, Win+R or by sending launch shortcuts");
    expect(skill).toContain("unless\n   the owner asked for that launch in this conversation");
    expect(skill).toContain("say what you are about\n   to type before you type it");
  });
  it("2: on a security/EDR block, access-denied launch error or antivirus notice stop, dismiss nothing, take no other route, report", () => {
    expect(skill).toContain("security or EDR block, an access-denied launch error or an antivirus\n   notification: stop all input at once");
    expect(skill).toContain("do not dismiss the dialogs");
    expect(skill).toContain("do not try another route (another shell, another\n   launcher)");
    expect(skill).toContain("report to the owner what was shown");
  });
  it("3: endpoint protection may flag automated input; that is a stated limit, not something to work around", () => {
    expect(skill).toContain("automated input may raise detections under the\n   owner's account");
    expect(skill).toContain("not something to work around");
  });
});
