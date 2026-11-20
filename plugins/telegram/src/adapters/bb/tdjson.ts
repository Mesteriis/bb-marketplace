import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

// Keep TDLib's blocking receive loop out of the BB process. Only the JSON
// protocol uses stdout. The helper never writes Telegram data to stderr.
const worker = String.raw`
import ctypes as c
import json, sys, threading

try:
    td = c.CDLL(sys.argv[1])
except OSError:
    print('{"@type":"makoshTdlibLoadFailed"}', flush=True)
    sys.exit(2)
td.td_create_client_id.restype = c.c_int
td.td_send.argtypes = [c.c_int, c.c_char_p]
td.td_send.restype = None
td.td_receive.argtypes = [c.c_double]
td.td_receive.restype = c.c_char_p
td.td_execute.argtypes = [c.c_char_p]
td.td_execute.restype = c.c_char_p
td.td_execute(b'{"@type":"setLogVerbosityLevel","new_verbosity_level":0}')
client = td.td_create_client_id()

def send():
    for line in sys.stdin.buffer:
        td.td_send(client, line)
    td.td_send(client, b'{"@type":"close"}')

threading.Thread(target=send, daemon=True).start()
while True:
    data = td.td_receive(1)
    if data is not None:
        event = json.loads(data)
        print(data.decode("utf-8"), flush=True)
        if event.get("authorization_state", {}).get("@type") == "authorizationStateClosed":
            break
`;

export function findTdjsonLibrary(override: string | undefined, exists: (path: string) => boolean = existsSync): string | undefined {
  const candidates = override ? [override] : [
    "/opt/homebrew/opt/tdlib/lib/libtdjson.dylib",
    "/usr/local/opt/tdlib/lib/libtdjson.dylib",
  ];
  return candidates.find(exists);
}

export type TdObject = { "@type": string; [key: string]: unknown };

export class TdTimeoutError extends Error {
  constructor() {
    super("TDLib request timed out");
  }
}

export class TdError extends Error {
  readonly unsupportedMethod: boolean;
  readonly communityRequestCreated: boolean;
  readonly preparedMessageError?: "ID_EXPIRED" | "ID_INVALID";
  readonly rpcErrorName?: string;

  constructor(readonly code: number, nativeMessage?: unknown) {
    super("Telegram rejected the request");
    this.unsupportedMethod = code === 400 && typeof nativeMessage === "string"
      && /^Failed to parse JSON object as TDLib request: Unknown class "[A-Za-z][A-Za-z0-9]*"$/.test(nativeMessage);
    this.communityRequestCreated = nativeMessage === "COMMUNITY_REQUEST_CREATED";
    if (code >= 400 && code < 500 && typeof nativeMessage === "string" && /^[A-Z][A-Z0-9_]{1,127}$/.test(nativeMessage)) {
      this.rpcErrorName = nativeMessage;
    }
    if (code === 400 && (nativeMessage === "ID_EXPIRED" || nativeMessage === "ID_INVALID")) {
      this.preparedMessageError = nativeMessage;
    }
  }
}

export function connectTdJson(library: string, onUpdate: (event: TdObject) => void, onStop: () => void) {
  const child = spawn("/usr/bin/python3", ["-I", "-u", "-c", worker, library], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  let next = 0;
  let stopped = false;
  const pending = new Map<number, (result: TdObject | Error) => void>();
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
  function stop() {
    if (stopped) return;
    stopped = true;
    lines.close();
    for (const done of pending.values()) done(new Error("TDLib stopped"));
    resolveExit();
    onStop();
  }
  child.once("error", stop);
  child.once("close", stop);
  child.stdin.on("error", () => child.kill());
  lines.on("line", (line) => {
    let event: TdObject;
    try { event = JSON.parse(line) as TdObject; } catch { child.kill(); return; }
    if (typeof event["@extra"] === "number") {
      pending.get(event["@extra"])?.(event);
    } else {
      onUpdate(event);
    }
  });
  return {
    request(query: TdObject, timeoutMs = 20_000, signal?: AbortSignal): Promise<TdObject> {
      if (stopped) return Promise.reject(new Error("TDLib stopped"));
      if (signal?.aborted) return Promise.reject(new Error("TDLib request cancelled"));
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new TdTimeoutError()), timeoutMs);
        const abort = () => finish(new Error("TDLib request cancelled"));
        function finish(result: TdObject | Error) {
          signal?.removeEventListener("abort", abort);
          clearTimeout(timer);
          pending.delete(id);
          if (result instanceof Error) reject(result);
          else if (result["@type"] === "error") reject(new TdError(Number(result.code), result.message));
          else resolve(result);
        }
        pending.set(id, finish);
        signal?.addEventListener("abort", abort, { once: true });
        child.stdin.write(JSON.stringify({ ...query, "@extra": id }) + "\n");
      });
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2500);
      try { await exit; } finally { clearTimeout(timer); }
    },
  };
}
