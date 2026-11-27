import { expect, it } from "vitest";
import { REQUIRED, authorize, type Grant } from "./permissions.ts";
import type { Initiator, OperationPlan, PlanItem, ResourceRef } from "./model.ts";
import { parsePosix } from "./path.ts";

const owner: Initiator = { kind: "owner" };
const agent: Initiator = { kind: "agent", threadId: "thr_agent" };

function ref(endpoint: string, path: string): ResourceRef {
  return { endpoint: endpoint as ResourceRef["endpoint"], path: parsePosix(path) };
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
  });
});

it("lets the owner do anything without grants", () => {
  const plan = planOf(
    "delete",
    [{ source: ref("host:x", "/etc/passwd"), target: null, kind: "file", fingerprint: null }],
    owner,
  );
  expect(authorize(owner, plan, [])).toEqual({ ok: true });
});

it("refuses to authorize a plan under another initiator", () => {
  const agentPlan = planOf(
    "delete",
    [{ source: ref("host:x", "/data/a"), target: null, kind: "file", fingerprint: null }],
    agent,
  );
  expect(() => authorize(owner, agentPlan, [])).toThrow(
    expect.objectContaining({ code: "internal" }),
  );
});

it("allows an agent whose grant scope covers every item", () => {
  const plan = planOf("copy", [
    {
      source: ref("host:x", "/data/a"),
      target: ref("host:x", "/data/b"),
      kind: "file",
      fingerprint: null,
    },
  ]);
  expect(authorize(agent, plan, grantReadWriteData)).toEqual({ ok: true });
});

it("reports read as missing when the agent cannot read an item outside the scope", () => {
  const plan = planOf("copy", [
    {
      source: ref("host:x", "/etc/passwd"),
      target: ref("host:x", "/data/passwd"),
      kind: "file",
      fingerprint: null,
    },
  ]);
  expect(authorize(agent, plan, grantReadWriteData)).toEqual({ ok: false, missing: ["read"] });
});

it("reports delete as missing for a move without the delete permission", () => {
  const plan = planOf("move", [
    {
      source: ref("host:x", "/data/a"),
      target: ref("host:x", "/data/b"),
      kind: "file",
      fingerprint: null,
    },
  ]);
  expect(authorize(agent, plan, grantReadWriteData)).toEqual({ ok: false, missing: ["delete"] });
});

it("requires write on the source of a rename, not only on the target", () => {
  // Grant covers /data/b only. Rename /data/a -> /data/b writes the source too.
  const plan = planOf("rename", [
    {
      source: ref("host:x", "/data/a"),
      target: ref("host:x", "/data/b"),
      kind: "file",
      fingerprint: null,
    },
  ]);
  const grants: Grant[] = [
    { endpoint: "host:x", permissions: ["write"], scope: parsePosix("/data/b") },
  ];
  expect(authorize(agent, plan, grants)).toEqual({ ok: false, missing: ["write"] });
});

it("requires a grant for the item's own endpoint", () => {
  const plan = planOf("copy", [
    {
      source: ref("host:y", "/data/a"),
      target: ref("host:x", "/data/b"),
      kind: "file",
      fingerprint: null,
    },
  ]);
  expect(authorize(agent, plan, grantReadWriteData)).toEqual({ ok: false, missing: ["read"] });
});

it("treats a null scope as granting no path", () => {
  const plan = planOf("delete", [
    { source: ref("host:x", "/data/a"), target: null, kind: "file", fingerprint: null },
  ]);
  const grants: Grant[] = [{ endpoint: "host:x", permissions: ["delete"], scope: null }];
  expect(authorize(agent, plan, grants)).toEqual({ ok: false, missing: ["delete"] });
});
