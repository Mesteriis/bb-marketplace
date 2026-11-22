import { describe, expect, it } from "vitest";
import { BRIDGE_MARKER, patchAccountPool } from "../src/core/pool-patch.js";

// A synthetic shape of the built Account Pooler: the ESM preamble, the hub's
// handle method and the server wiring around canServe. Minified names differ
// between builds, so the fixture uses its own.
const pool = [
  'import { createRequire as __createRequire } from "node:module";',
  "const require = __createRequire(import.meta.url);",
  "var __filename = __fileURLToPath(import.meta.url);",
  "var __dirname = __pathDirname(__filename);",
  "var X=class{async handle(e,A,r){let n=this.adapter(A),s=await this.authenticate(e);" +
    'if(s===null)return n.errorResponse(401,"Invalid Account Pooler bearer token.");' +
    'if(!this.accepting)return n.errorResponse(503,"Account Pooler is not accepting requests.");' +
    "let o=this.options.getParentRoute();return o!==null?this.forwardToParent(e,n,r,o):this.forward(e,new Uint8Array(await e.arrayBuffer()),n,s)}" +
    "trackRequest(e,A){return 1}};",
  'function k(A,m){A.rpc.register(c,{},{experimental_description:"Account Pooler retry availability for routed failed turns."}),EE(A,m),q(A);' +
    'let Y=i(async D=>await U.isRoutingEnabled(D)?1:0,"canServe"),O=1;return [Y,O]}',
  "export{k as default};",
].join("\n");

const bridge = "var __makoshPoolBridge=(()=>{return{registerPoolModelApi:()=>\"$&$'$`\"}})();";

describe("patchAccountPool", () => {
  it("inserts the bridge, splits handle and registers the model RPC", () => {
    const result = patchAccountPool(pool, bridge);
    if (result.kind !== "patched") throw new Error(JSON.stringify(result));
    const source = result.source;

    expect(source).toContain(`var __dirname = __pathDirname(__filename);\n${BRIDGE_MARKER}${bridge}\n`);
    expect(source).toContain(
      'async handle(e,A,r){let s=await this.authenticate(e);return s===null?this.adapter(A).errorResponse(401,"Invalid Account Pooler bearer token."):this.handleTrusted(e,A,r,s)}',
    );
    expect(source).toContain(
      'async handleTrusted(e,A,r,s){let n=this.adapter(A);if(!this.accepting)return n.errorResponse(503,"Account Pooler is not accepting requests.");',
    );
    expect(source).toContain(
      ',"canServe"),__makoshBridgeRegistered=__makoshPoolBridge.registerPoolModelApi(A,async(q,p,u)=>await Y(p)' +
        '?(q.signal.throwIfAborted(),m.handleTrusted(q,p,u,"plugin:makosh-ai"))' +
        ':Response.json({error:{message:"Account Pooler is unavailable for this provider."}},{status:503})),O=1;',
    );
    expect(result.names).toEqual({ bb: "A", hub: "m", canServe: "Y" });
  });

  it("keeps dollar sequences of the bridge bundle verbatim", () => {
    const result = patchAccountPool(pool, bridge);
    if (result.kind !== "patched") throw new Error(JSON.stringify(result));
    expect(result.source).toContain("\"$&$'$`\"");
  });

  it("recognises an already patched file", () => {
    const first = patchAccountPool(pool, bridge);
    if (first.kind !== "patched") throw new Error(JSON.stringify(first));
    expect(patchAccountPool(first.source, bridge)).toEqual({ kind: "already" });
  });

  it("refuses a bundle that is not the bridge", () => {
    expect(patchAccountPool(pool, "console.log(1)")).toEqual({ kind: "refused", reason: "bridge_bundle" });
  });

  it.each([
    ["preamble", pool.replace("var __dirname = __pathDirname(__filename);", "")],
    ["handle", pool.replace("async handle(e,A,r)", "async serve(e,A,r)")],
    ["wiring", pool.replace("Account Pooler retry availability for routed failed turns.", "renamed")],
    ["can_serve", pool.replace(',"canServe")', ',"canRoute")')],
  ])("refuses when the %s anchor is missing", (reason, source) => {
    expect(patchAccountPool(source, bridge)).toEqual({ kind: "refused", reason });
  });

  it("refuses when an anchor appears twice", () => {
    const twice = pool.replace("export{", 'var __dirname = __pathDirname(__filename);\nexport{');
    expect(patchAccountPool(twice, bridge)).toEqual({ kind: "refused", reason: "preamble" });
  });
});
