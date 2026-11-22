import { describe, expect, it, vi } from "vitest";
import { ensurePoolBridge, poolServerCandidates, type SelfInstallDeps } from "../src/adapters/bb/pool-self-install.js";

const runtime = "/srv/bb/runtime/node_modules/bb-app";
const target = `${runtime}/server/dist/builtin-plugins/account-pool/dist/server.js`;
const pool = [
  "var __dirname = __pathDirname(__filename);",
  "var X=class{async handle(e,A,r){let n=this.adapter(A),s=await this.authenticate(e);" +
    'if(s===null)return n.errorResponse(401,"Invalid Account Pooler bearer token.");' +
    "if(!this.accepting)return 0;return this.forward(e,n,s)}trackRequest(e){}};",
  'f({experimental_description:"Account Pooler retry availability for routed failed turns."}),EE(A,m);' +
    'let Y=i(async D=>await U.isRoutingEnabled(D)?1:0,"canServe"),O=1;',
].join("\n");
const bundle = "var __makoshPoolBridge=(()=>({registerPoolModelApi(){}}))();";

function setup(overrides: Partial<SelfInstallDeps> = {}, probes: string[] = ["bridge_missing", "present"]) {
  const files = new Map<string, string>([[target, pool]]);
  const queue = [...probes];
  const deps: SelfInstallDeps = {
    probe: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0]) as "present" | "bridge_missing" | "pool_missing"),
    hostEntry: `${runtime}/server/dist/index.js`,
    bundle,
    files: {
      exists: (path) => files.has(path),
      read: (path) => files.get(path) ?? "",
      writeAtomic: (path, text) => { files.set(path, text); },
      copyIfMissing: (from, to) => { if (!files.has(to)) files.set(to, files.get(from) ?? ""); },
    },
    reload: vi.fn(async () => {}),
    wait: async () => {},
    log: vi.fn(),
    ...overrides,
  };
  return { deps, files };
}

describe("poolServerCandidates", () => {
  it("walks up from the host entry to the bb-app runtime", () => {
    expect(poolServerCandidates(`${runtime}/host-daemon/dist/bb-plugin-host-worker.mjs`)).toContain(target);
    expect(poolServerCandidates(`${runtime}/server/dist/index.js`)).toContain(target);
  });
});

describe("ensurePoolBridge", () => {
  it("does nothing when the bridge already answers", async () => {
    const { deps, files } = setup({}, ["present"]);
    expect(await ensurePoolBridge(deps)).toEqual({ status: "present" });
    expect(deps.reload).not.toHaveBeenCalled();
    expect(files.get(target)).toBe(pool);
  });

  it("patches Account Pooler, keeps the original and reloads it", async () => {
    const { deps, files } = setup();
    expect(await ensurePoolBridge(deps)).toEqual({ status: "installed", file: target });
    expect(files.get(`${target}.orig`)).toBe(pool);
    expect(files.get(target)).toContain("__makoshPoolBridge.registerPoolModelApi(A,");
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it("waits for Account Pooler instead of patching when it is not running", async () => {
    const { deps, files } = setup({}, ["pool_missing"]);
    expect(await ensurePoolBridge(deps)).toEqual({ status: "pool_missing" });
    expect(files.get(target)).toBe(pool);
  });

  it("refuses to touch a signed application bundle", async () => {
    const app = "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app";
    const { deps, files } = setup({ hostEntry: `${app}/server/dist/index.js` });
    files.set(`${app}/server/dist/builtin-plugins/account-pool/dist/server.js`, pool);
    expect(await ensurePoolBridge(deps)).toEqual({ status: "skipped", reason: "signed_bundle" });
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("reports a missing Account Pooler file", async () => {
    const { deps } = setup({ hostEntry: "/elsewhere/index.js" });
    expect(await ensurePoolBridge(deps)).toEqual({ status: "skipped", reason: "not_found" });
  });

  it("leaves an unknown Account Pooler build alone", async () => {
    const { deps, files } = setup();
    files.set(target, pool.replace(',"canServe")', ',"canRoute")'));
    expect(await ensurePoolBridge(deps)).toEqual({ status: "skipped", reason: "refused:can_serve" });
    expect(files.has(`${target}.orig`)).toBe(false);
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("reloads a file patched earlier that the running pool has not picked up", async () => {
    const { deps, files } = setup();
    const first = await ensurePoolBridge(deps);
    expect(first.status).toBe("installed");
    const again = setup({ files: { ...deps.files, read: (path) => files.get(path) ?? "" } });
    expect(await ensurePoolBridge(again.deps)).toEqual({ status: "installed", file: target });
    expect(again.deps.reload).toHaveBeenCalledTimes(1);
  });

  it("reports when the bridge still does not answer after the reload", async () => {
    const { deps } = setup({}, ["bridge_missing"]);
    expect(await ensurePoolBridge(deps)).toEqual({ status: "skipped", reason: "still_missing" });
  });
});
