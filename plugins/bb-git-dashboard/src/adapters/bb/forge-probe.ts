const limit = 64 * 1024;
const timeout = 4_000;
type Answer = {status: number; json: Record<string, unknown> | null} | "unreachable";

async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

async function ask(origin: string, path: string, send: typeof fetch): Promise<Answer> {
  try {
    const response = await send(new URL(path, origin), {
      method: "GET", redirect: "manual", credentials: "omit",
      headers: {accept: "application/json"}, signal: AbortSignal.timeout(timeout),
    });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return {status: response.status, json: null}; }
    return {status: response.status, json: await boundedJson(response)};
  } catch { return "unreachable"; }
}

/** Identifies a self-hosted forge from its public version endpoint. The response is untrusted data. */
export async function probeForge(origin: string, send: typeof fetch = fetch): Promise<"gitea" | "gitlab" | null | "unreachable"> {
  const [gitea, gitlab] = await Promise.all([ask(origin, "/api/v1/version", send), ask(origin, "/api/v4/version", send)]);
  if (gitea !== "unreachable" && gitea.status === 200 && typeof gitea.json?.version === "string") return "gitea";
  if (gitlab !== "unreachable") {
    if (gitlab.status === 200 && typeof gitlab.json?.version === "string" && typeof gitlab.json.revision === "string") return "gitlab";
    if (gitlab.status === 401 && typeof gitlab.json?.message === "string") return "gitlab";
  }
  return gitea === "unreachable" && gitlab === "unreachable" ? "unreachable" : null;
}
