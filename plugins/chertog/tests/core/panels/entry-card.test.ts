import { expect, it } from "vitest";
import { entryCards, entryRoute, fileTarget } from "../../../src/core/panels/entry-card.ts";
import { PanelRegistry } from "../../../src/core/panels/index.ts";
import { FakeClock, FakeDiagnostics, FakeProvider, SequentialIds } from "./fakes.ts";

it("holds an entry without acquiring a session or asking to end it on last close", async () => {
  const registry = new PanelRegistry({ clock: new FakeClock(1), ids: new SequentialIds(), diagnostics: new FakeDiagnostics() });
  const owner = new FakeProvider("telegram", []);
  owner.openResult = async () => ({ status: "entry" });
  owner.endsSession = true;
  registry.registerProvider(owner);
  const opened = registry.open({ provider: "telegram", params: {} });
  if (!opened.ok) throw Error(opened.reason);
  expect(await opened.settled).toMatchObject({ state: "entry", addressee: null, unknownOutcome: null });
  expect(await registry.endSession("panel-1")).toEqual({ status: "not-live" });
  expect(await registry.close("panel-1")).toEqual({ status: "closed", release: "done" });
  expect(owner.releases).toEqual(["panel-1"]);
  expect(owner.endSessions).toEqual([]);
});

it.each([
  ["telegram", {}], ["zoom", {}], ["remote-ssh", {}], ["remote-rdp", {}], ["remote-vnc", {}], ["terminals", {}],
  ["markdown-editor", { kind: "workspace", environmentId: "env", path: "my%20notes.md" }],
  ["bb-editor", { kind: "workspace", environmentId: "env", path: "code.ts" }],
  ["bb-desktop-tab", { hostId: "h", threadId: "t" }],
  ["bb-terminal", { terminalId: "tty" }], ["app-preview", { threadId: "thr" }],
  ["app-preview", { threadId: "thr", tabId: "tab" }],
  ["diff-review", { threadId: "thr", kind: "uncommitted" }],
  ["diff-review", { threadId: "thr", kind: "commit", sha: "0123456789012345678901234567890123456789" }],
] as const)("accepts only declared parameters for %s", (type, params) => {
  expect(entryCards[type].paramsSchema.safeParse(params).success).toBe(true);
  expect(entryCards[type].paramsSchema.safeParse({ ...params, subPath: "override" }).success).toBe(false);
});

it("builds only the registered diff route and decodes file targets once", () => {
  expect(entryRoute({ provider: "diff-review", params: { threadId: "t/a", kind: "uncommitted" } }))
    .toBe("/plugins/diff-review/reviews/t%2Fa/%257B%2522kind%2522%253A%2522uncommitted%2522%257D");
  expect(fileTarget({ kind: "workspace", environmentId: "env", path: "docs/my%20file.md" }).path).toBe("docs/my file.md");
  for (const path of ["../x", "a/%2e%2e/x", "/abs", "C:%5Cdir", "%00bad", "%ff"]) {
    expect(entryCards["bb-editor"].paramsSchema.safeParse({ kind: "workspace", environmentId: "env", path }).success).toBe(false);
  }
});
