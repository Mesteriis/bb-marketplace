import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CommanderError, CommanderErrorShape } from "../../core/errors.ts";
import { EDIT_SNAPSHOT_ENDPOINT, EditId } from "../../core/edit-session.ts";
import { EDIT_CHUNK } from "../../core/edit-source.ts";
import type { Endpoint, Fingerprint, ResourceRef } from "../../core/model.ts";
import type { ResourcePath } from "../../core/path.ts";
import type { FileProvider } from "../../core/provider.ts";
import { matches } from "../../core/reconcile.ts";
import { editHostSchemas } from "../../core/wire/edit.ts";

type Methods = typeof editHostSchemas;
const snapshotPath = z.tuple([
  z.strictObject({ t: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
  z.strictObject({ t: EditId }), z.strictObject({ t: EditId }),
]);

export function snapshotRef(hostId: string, sessionId: string, snapshotId: string): ResourceRef {
  return { endpoint: EDIT_SNAPSHOT_ENDPOINT, path: { segments: [{ t: hostId }, { t: sessionId }, { t: snapshotId }] } };
}

export function snapshotIds(path: ResourcePath) {
  const parts = snapshotPath.safeParse(path.segments);
  if (!parts.success) throw new CommanderError("invalid_path", "Invalid private snapshot reference");
  return { hostId: parts.data[0].t, sessionId: parts.data[1].t, snapshotId: parts.data[2].t };
}

export function createEditHostClient(bb: BbPluginApi) {
  const client = bb.hosts.experimental_client({ contract: editHostSchemas });

  async function primaryHost() {
    const { primaryHostId } = await bb.sdk.system.config();
    if (!primaryHostId) throw new CommanderError("unsupported", "Хост редактора BB недоступен");
    return primaryHostId;
  }

  async function call<K extends keyof Methods>(
    method: K, input: z.infer<Methods[K]["input"]>, hostId: string, signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    try {
      return await client.call(method, input, { hostId, signal });
    } catch (error) {
      if (error instanceof Error && error.message.length <= 4096) {
        let payload: unknown;
        try { payload = JSON.parse(error.message.replace(/^HTTP [0-9]+: /, "")); } catch { /* unstructured transport error */ }
        const parsed = CommanderErrorShape.safeParse(payload);
        if (parsed.success) {
          throw new CommanderError(parsed.data.code, parsed.data.message, parsed.data.retryable);
        }
      }
      throw new CommanderError("connection_failed", "Хост редактора BB недоступен", true);
    }
  }

  function provider(): FileProvider {
    const endpoint: Endpoint = {
      id: EDIT_SNAPSHOT_ENDPOINT, provider: "local", label: "Commander", machine: "Commander",
      hostId: null, readOnly: true, caseSensitive: true,
    };
    async function inspect(path: ResourcePath, signal: AbortSignal) {
      const { hostId, ...params } = snapshotIds(path);
      const proof = await call("editInspectSnapshot", params, hostId, signal);
      return { ...params, hostId, proof };
    }
    const readonly = async () => { throw new CommanderError("permission_denied", "Path is outside the agent's grant"); };
    return {
      endpoint, capabilities: new Set(["stat", "read", "checksum", "seek"]),
      list: readonly, mkdir: readonly, openWrite: readonly, rename: readonly, remove: readonly,
      async stat(path, signal) {
        const { proof, snapshotId } = await inspect(path, signal);
        if (proof === null) return null;
        return {
          name: { t: snapshotId }, kind: "file", size: proof.size, mtimeNs: proof.mtimeNs,
          mtimePrecision: "ns", mode: null, linkTarget: null, hidden: true,
        };
      },
      async read(path, offset, length, expect: Fingerprint | null, signal) {
        const { proof, snapshotId, sessionId, hostId } = await inspect(path, signal);
        if (proof === null || expect && !matches(proof, expect)) {
          throw new CommanderError("changed_since_plan", "Private snapshot changed");
        }
        const { bytes } = await call("editReadChunk", {
          sessionId, source: { snapshotId }, offset: Number(offset), length: Math.min(length, EDIT_CHUNK),
        }, hostId, signal);
        return Buffer.from(bytes, "base64");
      },
      async sha256(path, signal) {
        const { proof } = await inspect(path, signal);
        if (proof === null) throw new CommanderError("not_found", "Private snapshot is unavailable");
        return proof.sha256;
      },
    };
  }
  return { primaryHost, call, provider };
}
export type EditHost = ReturnType<typeof createEditHostClient>;
