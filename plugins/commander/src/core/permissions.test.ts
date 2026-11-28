import { expect, it } from "vitest";
import { REQUIRED, authorize, type Grant } from "./permissions.ts";
import type { EntryKind, Initiator, OperationPlan, PlanItem, ResourceRef } from "./model.ts";
import { parsePosix } from "./path.ts";

const owner: Initiator = { kind: "owner" };
const agent: Initiator = { kind: "agent", threadId: "thr_agent" };

function ref(endpoint: string, path: string): ResourceRef {
  return { endpoint: endpoint as ResourceRef["endpoint"], path: parsePosix(path) };
}

/** A plan item; expectTarget is "absent" whenever there is a target. */
function item(source: ResourceRef | null, target: ResourceRef | null, kind: EntryKind = "file"): PlanItem {
  return {
    source,
    target,
    kind,
    fingerprint: source === null ? null : { size: "1", mtimeNs: "1000000000" },
    expectTarget: target === null ? null : "absent",
  };
}

function planOf(
  kind: OperationPlan["kind"],
  items: PlanItem[],
  initiator: Initiator = agent,
): OperationPlan {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    kind,
    createdAt: "2026-11-27T00:00:00.000Z",
    initiator,
    sourceEndpoint: "host:x",
    targetEndpoint: kind === "delete" ? null : "host:x",
    targetDir: kind === "delete" ? null : ref("host:x", "/data"),
    items,
    conflictPolicy: "ask",
    route: "same-endpoint",
    verify: "size",
    totalBytes: "0",
    digest: "0".repeat(64),
  };
}

const grantReadWriteData: Grant[] = [
  { endpoint: "host:x", permissions: ["read", "write"], scope: parsePosix("/data") },
];

it("lists the required permissions per operation kind", () => {
  expect(REQUIRED).toEqual({
    copy: ["read", "write"],
    move: ["read", "write", "delete"],
    rename: ["write"],
    mkdir: ["write"],
    delete: ["delete"],
    pack: ["read", "write"],
  });
});

it("lets the owner do anything without grants", () => {
  const plan = planOf("delete", [item(ref("host:x", "/etc/passwd"), null)], owner);
  expect(authorize(owner, plan, [])).toEqual({ ok: true });
});

it("refuses to authorize a plan under another initiator", () => {
  const agentPlan = planOf("delete", [item(ref("host:x", "/data/a"), null)], agent);
  expect(() => authorize(owner, agentPlan, [])).toThrow(
    expect.objectContaining({ code: "internal" }),
  );
});

it("allows an agent whose grant scope covers every item", () => {
  const plan = planOf("copy", [item(ref("host:x", "/data/a"), ref("host:x", "/data/b"))]);
  expect(authorize(agent, plan, grantReadWriteData)).toEqual({ ok: true });
});

it("reports read as missing when the agent cannot read an item outside the scope", () => {
  const plan = planOf("copy", [item(ref("host:x", "/etc/passwd"), ref("host:x", "/data/passwd"))]);
  expect(authorize(agent, plan, grantReadWriteData)).toEqual({ ok: false, missing: ["read"] });
});

it("reports delete as missing for a move without the delete permission", () => {
  const plan = planOf("move", [item(ref("host:x", "/data/a"), ref("host:x", "/data/b"))]);
  expect(authorize(agent, plan, grantReadWriteData)).toEqual({ ok: false, missing: ["delete"] });
});

it("requires write on the source of a rename, not only on the target", () => {
  // Grant covers /data/b only. Rename /data/a -> /data/b writes the source too.
  const plan = planOf("rename", [item(ref("host:x", "/data/a"), ref("host:x", "/data/b"))]);
  const grants: Grant[] = [
    { endpoint: "host:x", permissions: ["write"], scope: parsePosix("/data/b") },
  ];
  expect(authorize(agent, plan, grants)).toEqual({ ok: false, missing: ["write"] });
});

it("requires a grant for the item's own endpoint", () => {
  const plan = planOf("copy", [item(ref("host:y", "/data/a"), ref("host:x", "/data/b"))]);
  expect(authorize(agent, plan, grantReadWriteData)).toEqual({ ok: false, missing: ["read"] });
});

it("treats a null scope as granting no path", () => {
  const plan = planOf("delete", [item(ref("host:x", "/data/a"), null)]);
  const grants: Grant[] = [{ endpoint: "host:x", permissions: ["delete"], scope: null }];
  expect(authorize(agent, plan, grants)).toEqual({ ok: false, missing: ["delete"] });
});
