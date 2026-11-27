import { useBbContext, useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { useRef } from "react";
import { z } from "zod";
import { targetFromKey, targetRequestSchema, type TargetRequest } from "../core/code-review/model.ts";
import { keepView, readView, viewScope } from "../core/code-review/view-memory.ts";

const openRequest = z.object({threadId: z.string(), copyId: z.string(), target: targetRequestSchema, file: z.string().max(4096).nullable()});

/** A session's view as the Review's picker asks for it: a branch view keeps no empty base. */
export function requestOfKey(key: string): TargetRequest {
  const target = targetFromKey(key);
  return (target.kind === "branch" || target.kind === "all") && !target.base ? {kind: target.kind} : target;
}

/**
 * The Git panel route of a copy's Review at a file, after keeping `target` as the copy's Review memory
 * (view-memory.ts), which the Review starts from.
 */
export function reviewRoute(copyId: string, target: TargetRequest, file: string | null) {
  const storage = (() => { try { return window.localStorage; } catch { return undefined; } })();
  const scope = viewScope(copyId, undefined);
  keepView(storage, scope, {...readView(storage, scope), target});
  return copyId + "/review" + (file ? "/" + encodeURIComponent(file) : "");
}

/**
 * `bb git-dashboard review open` asks BB's windows to open a thread's Review: the window showing that thread opens
 * its copy's Review in Git, on the view and at the file asked for. Renders nothing. Follows diff-review
 * app/open-overlay.tsx (MIT, gpambrozio); see THIRD_PARTY_NOTICES.md.
 */
export function ReviewOpenOverlay() {
  const navigate = useBbNavigate();
  const context = useBbContext();
  const thread = useRef(context.threadId);
  thread.current = context.threadId;
  useRealtime("code-review-open", payload => {
    const request = openRequest.safeParse(payload);
    if (!request.success || request.data.threadId !== thread.current) return;
    navigate.toPluginPanel("git", {subPath: reviewRoute(request.data.copyId, request.data.target, request.data.file)});
  });
  return null;
}
