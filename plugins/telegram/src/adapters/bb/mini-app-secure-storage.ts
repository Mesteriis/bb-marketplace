import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { maxMiniAppDeviceStorageBytes, miniAppDeviceStorageOperation, miniAppSecureStorageResult, type MiniAppSecureStorageResult, type MiniAppDeviceStorageOperation } from "../../core/contract.ts";

// The helper exchanges values only through pipes. Keychain access never puts a
// value in a command argument, an environment variable, or an application log.
const worker = String.raw`
import ctypes as c
import fcntl, json, os, sys

def main():
    request = json.load(sys.stdin)
    os.umask(0o077)
    with open(request["lock"], "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cf = c.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        sec = c.CDLL("/System/Library/Frameworks/Security.framework/Security")
        ptr = c.c_void_p
        cf.CFStringCreateWithCString.argtypes = [ptr, c.c_char_p, c.c_uint32]
        cf.CFStringCreateWithCString.restype = ptr
        cf.CFDataCreate.argtypes = [ptr, c.c_char_p, c.c_long]
        cf.CFDataCreate.restype = ptr
        cf.CFDictionaryCreateMutable.argtypes = [ptr, c.c_long, ptr, ptr]
        cf.CFDictionaryCreateMutable.restype = ptr
        cf.CFDictionarySetValue.argtypes = [ptr, ptr, ptr]
        cf.CFRelease.argtypes = [ptr]
        cf.CFDataGetLength.argtypes = [ptr]
        cf.CFDataGetLength.restype = c.c_long
        cf.CFDataGetBytePtr.argtypes = [ptr]
        cf.CFDataGetBytePtr.restype = ptr
        sec.SecItemCopyMatching.argtypes = [ptr, c.POINTER(ptr)]
        sec.SecItemCopyMatching.restype = c.c_int32
        sec.SecItemAdd.argtypes = [ptr, ptr]
        sec.SecItemAdd.restype = c.c_int32
        sec.SecItemUpdate.argtypes = [ptr, ptr]
        sec.SecItemUpdate.restype = c.c_int32
        sec.SecItemDelete.argtypes = [ptr]
        sec.SecItemDelete.restype = c.c_int32
        owned = []
        def string(text):
            value = cf.CFStringCreateWithCString(None, text.encode("utf-8"), 0x08000100)
            if not value:
                raise ValueError()
            owned.append(value)
            return value
        def symbol(name):
            return ptr.in_dll(sec, name).value
        def dictionary(entries):
            value = cf.CFDictionaryCreateMutable(None, 0, None, None)
            if not value:
                raise ValueError()
            owned.append(value)
            for key, item in entries:
                cf.CFDictionarySetValue(value, symbol(key), item)
            return value
        try:
            identity = [("kSecClass", symbol("kSecClassGenericPassword")),
                        ("kSecAttrService", string("Makosh Telegram Mini App SecureStorage")),
                        ("kSecAttrAccount", string(request["namespace"]))]
            query = dictionary(identity + [("kSecReturnData", ptr.in_dll(cf, "kCFBooleanTrue").value),
                                           ("kSecMatchLimit", symbol("kSecMatchLimitOne")),
                                           ("kSecUseAuthenticationUI", symbol("kSecUseAuthenticationUIFail"))])
            result = ptr()
            status = sec.SecItemCopyMatching(query, c.byref(result))
            if status not in (0, -25300):
                raise ValueError()
            values = {}
            if status == 0:
                try:
                    size = cf.CFDataGetLength(result)
                    values = json.loads(c.string_at(cf.CFDataGetBytePtr(result), size).decode("utf-8"))
                finally:
                    cf.CFRelease(result)
            if not isinstance(values, dict) or len(values) > 10 or any(
                not isinstance(k, str) or not isinstance(v, str) for k, v in values.items()):
                raise ValueError()
            operation = request["operation"]
            kind = operation["kind"]
            if kind == "get":
                return {"status": "ok", "value": values.get(operation["key"])}
            if kind == "clear":
                status = sec.SecItemDelete(dictionary(identity))
                if status not in (0, -25300):
                    raise ValueError()
                return {"status": "ok", "value": None}
            key, value = operation["key"], operation["value"]
            if value is None:
                values.pop(key, None)
            else:
                if key not in values and len(values) == 10:
                    return {"status": "failed", "error": "QUOTA_EXCEEDED"}
                values[key] = value
            if not values:
                status = sec.SecItemDelete(dictionary(identity))
                if status not in (0, -25300):
                    raise ValueError()
            else:
                data = json.dumps(values, ensure_ascii=True).encode("ascii")
                blob = cf.CFDataCreate(None, data, len(data))
                if not blob:
                    raise ValueError()
                owned.append(blob)
                if status == -25300:
                    status = sec.SecItemAdd(dictionary(identity + [("kSecValueData", blob)]), None)
                else:
                    status = sec.SecItemUpdate(dictionary(identity), dictionary([("kSecValueData", blob)]))
                if status != 0:
                    raise ValueError()
            return {"status": "ok", "value": None}
        finally:
            for value in reversed(owned):
                cf.CFRelease(value)

try:
    print(json.dumps(main(), ensure_ascii=True))
except Exception:
    print('{"status":"failed","error":"UNKNOWN_ERROR"}')
`;

type Operation = MiniAppDeviceStorageOperation;
type KeychainRequest = { lock: string; namespace: string; operation: Operation };

function nativeKeychain(request: KeychainRequest): Promise<MiniAppSecureStorageResult> {
  if (process.platform !== "darwin") return Promise.resolve({ status: "failed", error: "UNSUPPORTED" });
  return new Promise((resolveResult) => {
    const child = spawn("/usr/bin/python3", ["-I", "-u", "-c", worker], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    let bytes = 0;
    let failed = false;
    const timeout = setTimeout(() => { failed = true; child.kill(); }, 15_000);
    child.on("error", () => {
      failed = true;
      clearTimeout(timeout);
      resolveResult({ status: "failed", error: "UNKNOWN_ERROR" });
    });
    child.stdin.on("error", () => { failed = true; });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxMiniAppDeviceStorageBytes * 6 + 1024) { failed = true; child.kill(); }
      else output += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      try {
        const parsed = miniAppSecureStorageResult.safeParse(JSON.parse(output));
        resolveResult(!failed && code === 0 && parsed.success ? parsed.data : { status: "failed", error: "UNKNOWN_ERROR" });
      } catch { resolveResult({ status: "failed", error: "UNKNOWN_ERROR" }); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function createMiniAppSecureStorage(directory: string, run = nativeKeychain) {
  const root = resolve(directory);
  return async (account: string, bot: number, operation: Operation): Promise<MiniAppSecureStorageResult> => {
    const parsed = miniAppDeviceStorageOperation.safeParse(operation);
    if (!account || !Number.isSafeInteger(bot) || bot <= 0 || !parsed.success) return { status: "failed", error: "UNKNOWN_ERROR" };
    const namespace = createHash("sha256").update(JSON.stringify([root, account, bot])).digest("hex");
    try {
      return await run({ lock: resolve(root, ".mini-app-keychain.lock"), namespace, operation: parsed.data });
    } catch { return { status: "failed", error: "UNKNOWN_ERROR" }; }
  };
}
