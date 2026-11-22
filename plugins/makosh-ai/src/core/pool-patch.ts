// Adds the Makosh AI model bridge to a built Account Pooler server bundle.
// Pure string transformation: it finds stable anchors (texts and shapes that
// survive minification), never minified names, and refuses instead of guessing
// when the bundle does not look like the one it was written against.

export const BRIDGE_MARKER = "/*makosh-ai-pool-bridge:v1*/";
const BRIDGE_PREFIX = "var __makoshPoolBridge=";

export type PatchRefusal = "bridge_bundle" | "preamble" | "handle" | "wiring" | "can_serve";
export type PatchResult =
  | { kind: "patched"; source: string; names: { bb: string; hub: string; canServe: string } }
  | { kind: "already" }
  | { kind: "refused"; reason: PatchRefusal };

// The bridge relies on the preamble's `require`, so it goes right after it.
const PREAMBLE = "var __dirname = __pathDirname(__filename);\n";
// AccountPoolHub.handle(request, provider, route) with authentication inline.
const HANDLE = /async handle\((\w+),(\w+),(\w+)\)\{let (\w+)=this\.adapter\(\2\),(\w+)=await this\.authenticate\(\1\);if\(\5===null\)return \4\.errorResponse\(401,"Invalid Account Pooler bearer token\."\);(if\(!this\.accepting\)[^]*?)\}(?=trackRequest\()/g;
// The server wires the hub right after the retry-availability RPC: fn(bb, hub).
const WIRING = /"Account Pooler retry availability for routed failed turns\."\}\),\w+\((\w+),(\w+)\)/g;
const CAN_SERVE = /let (\w+)=\w+\(async (\w+)=>await \w+\.isRoutingEnabled\(\2\)[^]*?,"canServe"\)/g;

function occurrences(source: string, text: string): number {
  return source.split(text).length - 1;
}

export function patchAccountPool(pool: string, bridge: string): PatchResult {
  if (pool.includes(BRIDGE_MARKER)) return { kind: "already" };
  const bundle = bridge.trim();
  if (!bundle.startsWith(BRIDGE_PREFIX)) return { kind: "refused", reason: "bridge_bundle" };
  if (occurrences(pool, PREAMBLE) !== 1) return { kind: "refused", reason: "preamble" };

  const handles = [...pool.matchAll(HANDLE)];
  if (handles.length !== 1) return { kind: "refused", reason: "handle" };
  const wirings = [...pool.matchAll(WIRING)];
  if (wirings.length !== 1) return { kind: "refused", reason: "wiring" };
  const canServes = [...pool.matchAll(CAN_SERVE)];
  if (canServes.length !== 1) return { kind: "refused", reason: "can_serve" };

  const [, bb = "", hub = ""] = wirings[0] ?? [];
  const canServeMatch = canServes[0];
  const canServe = canServeMatch?.[1] ?? "";

  // Replacement callbacks, not strings: the bundle contains `$&`, `$'` and the like.
  let source = pool.replace(PREAMBLE, () => `${PREAMBLE}${BRIDGE_MARKER}${bundle}\n`);
  source = source.replace(HANDLE, (_match, req: string, provider: string, route: string, adapter: string, key: string, body: string) =>
    `async handle(${req},${provider},${route}){let ${key}=await this.authenticate(${req});` +
    `return ${key}===null?this.adapter(${provider}).errorResponse(401,"Invalid Account Pooler bearer token."):this.handleTrusted(${req},${provider},${route},${key})}` +
    `async handleTrusted(${req},${provider},${route},${key}){let ${adapter}=this.adapter(${provider});${body}}`);

  const anchor = [...source.matchAll(CAN_SERVE)][0];
  if (!anchor || anchor.index === undefined) return { kind: "refused", reason: "can_serve" };
  const end = anchor.index + anchor[0].length;
  const registration =
    `,__makoshBridgeRegistered=__makoshPoolBridge.registerPoolModelApi(${bb},async(q,p,u)=>await ${canServe}(p)` +
    `?(q.signal.throwIfAborted(),${hub}.handleTrusted(q,p,u,"plugin:makosh-ai"))` +
    `:Response.json({error:{message:"Account Pooler is unavailable for this provider."}},{status:503}))`;
  source = source.slice(0, end) + registration + source.slice(end);
  return { kind: "patched", source, names: { bb, hub, canServe } };
}
