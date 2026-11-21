// server.ts as BB loads it: what the plugin registers, and the workspace RPC
// from the request a window sends to the row left in storage.
import { describe, expect, it } from "vitest";
import plugin, { rpcContract } from "../../../server.ts";
import { loadWorkspaceOutputSchema, saveWorkspaceInputSchema, saveWorkspaceOutputSchema } from "../../../src/core/wire/index.ts";
import { stageADocument, stageAJson } from "../../core/workspace/fixtures.ts";
import type { FakeHost } from "./support.ts";
import { fakeHost, FakeKv } from "./support.ts";

type Handler = (input: unknown, context: unknown) => unknown;

function loaded(kv: FakeKv = new FakeKv()): FakeHost & { handlers: Record<string, Handler> } {
  const host = fakeHost(kv);
  plugin(host.bb);
  return { ...host, handlers: host.rpc.registered[0].handlers };
}

/** A call as the host makes it: the input is validated, the handler runs, the output is validated. */
async function call(handlers: Record<string, Handler>, method: "load_workspace" | "save_workspace", input: unknown): Promise<unknown> {
  const contract = rpcContract[method];
  const output = await handlers[method](contract.input.parse(input), {});
  return contract.output.parse(output);
}

describe("what the server registers", () => {
  it("registers the workspace RPC and the fixture route, and nothing else", () => {
    const { rpc, http, kv, log } = loaded();
    expect(rpc.registered).toHaveLength(1);
    expect(rpc.registered[0].contract).toBe(rpcContract);
    expect(Object.keys(rpc.registered[0].contract)).toEqual(["load_workspace", "save_workspace"]);
    expect(Object.keys(rpc.registered[0].handlers)).toEqual(["load_workspace", "save_workspace"]);
    expect(http.routes).toEqual([{ method: "GET", path: "/fixtures/live-frame.html", auth: undefined }]);
    // Loading the plugin reads and writes nothing.
    expect(kv.calls).toEqual([]);
    expect(log.lines).toEqual([]);
  });

  it("serves the contract of the wire schemas", () => {
    expect(rpcContract.load_workspace.output).toBe(loadWorkspaceOutputSchema);
    expect(rpcContract.save_workspace.input).toBe(saveWorkspaceInputSchema);
    expect(rpcContract.save_workspace.output).toBe(saveWorkspaceOutputSchema);
  });

  it("serves the fixture page found from server.ts", async () => {
    const response = await loaded().http.request("/fixtures/live-frame.html?instance=tile-1");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Chertog live frame fixture</title>");
  });
});

describe("workspace RPC", () => {
  it("answers the first entry with nothing stored", async () => {
    expect(await call(loaded().handlers, "load_workspace", {})).toEqual({ status: "empty" });
  });

  it("saves the two named layouts and returns them after the plugin is loaded again", async () => {
    const kv = new FakeKv();
    const saved = await call(loaded(kv).handlers, "save_workspace", { document: stageADocument(), expectedRevision: 0 });
    expect(saved).toEqual({ status: "saved", document: { ...stageADocument(), revision: 1 } });

    const read = await call(loaded(kv).handlers, "load_workspace", {});
    expect(read).toEqual({ status: "ok", document: { ...stageADocument(), revision: 1 }, migratedFrom: null, dropped: [] });
  });

  it("gives one of two windows that save at once a conflict with the other's document", async () => {
    const { handlers, kv } = loaded();
    const fromA = { ...stageAJson(), activeLayoutId: "layout-dev" };
    const fromB = { ...stageAJson(), activeLayoutId: "layout-review" };
    const results = await Promise.all([
      call(handlers, "save_workspace", { document: fromA, expectedRevision: 0 }),
      call(handlers, "save_workspace", { document: fromB, expectedRevision: 0 }),
    ]);
    expect(results).toEqual([
      { status: "saved", document: { ...stageADocument(), activeLayoutId: "layout-dev", revision: 1 } },
      { status: "conflict", current: { ...stageADocument(), activeLayoutId: "layout-dev", revision: 1 } },
    ]);
    expect(kv.value("workspace/document")).toEqual({ ...stageADocument(), activeLayoutId: "layout-dev", revision: 1 });
  });

  it("answers a document with a credential with `rejected` and the reason", async () => {
    const { handlers, kv, log } = loaded();
    const document = stageAJson();
    document.panels["thread-b"].ref.params.cookie = "hunter2";
    const result = await call(handlers, "save_workspace", { document, expectedRevision: 0 });
    expect(result).toEqual({ status: "rejected", reason: expect.any(String) });
    expect((result as { reason: string }).reason).not.toContain("hunter2");
    expect(kv.keys()).toEqual([]);
    expect(log.lines).toEqual([]);
  });
});
