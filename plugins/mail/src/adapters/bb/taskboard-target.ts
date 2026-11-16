// Makosh Taskboard as the target of "Make a task" (slice 3g, spec
// resolution 16): the local boards (Jira boards left out) and task creation
// through bb.sdk.plugins.callRpc. It fails soft: Taskboard absent or
// disabled, BB not answering before the call, and a call BB itself refused
// are "unavailable" (the page then offers the local task); only Taskboard's
// own refusals (not_found, invalid, conflict, with its fixed message) are
// "refused". Once task_create was sent, any other error (a timeout) or a
// malformed answer is "uncertain": Taskboard may have made the task, so no
// local copy is offered (review). The input is the redacted text bb-text.ts
// built; nothing else is sent. Never throws.
import { experimental_PluginRpcCallError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TaskTarget } from "../../core/ports.ts";

export const TASKBOARD_PLUGIN_ID = "makosh-taskboard";

/** Why Taskboard is not offered (fixed text). */
export const TASKBOARD_UNAVAILABLE = "Taskboard did not answer";
export const TASKBOARD_NOT_INSTALLED = "Taskboard is not installed or is turned off";
export const TASKBOARD_MAYBE_CREATED = "Taskboard may have created it; check the board";
/** callRpc codes for a call refused before Taskboard ran it (rpcErrorCodes in the SDK): nothing was created. */
const NOT_SENT_CODES = new Set(["unknown_method", "forbidden", "invalid_json", "invalid_input"]);

/** Taskboard's own refusal codes, shown as "Taskboard: <its message>". */
const TASKBOARD_REFUSALS = new Set(["not_found", "invalid", "conflict"]);
const MESSAGE_MAX = 300;
/** Boards read from Taskboard. */
const BOARDS_MAX = 200;

type PluginsSdk = Pick<BbPluginApi["sdk"], "plugins">;

/** Reads only id, name and connectionId; extra keys are allowed (Taskboard may grow). */
const boardsSchema = z.object({
  boards: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        name: z.string().max(500),
        connectionId: z.string().nullable(),
      }),
    )
    .max(BOARDS_MAX),
});

const createdSchema = z.object({ task: z.object({ id: z.string().min(1).max(200) }) });

export function createTaskboardTarget(sdk: PluginsSdk): TaskTarget {
  async function available(): Promise<boolean> {
    const listed = await sdk.plugins.list();
    return listed.plugins.some((plugin) => plugin.id === TASKBOARD_PLUGIN_ID && plugin.enabled);
  }

  return {
    async boards() {
      try {
        if (!(await available())) return { unavailable: TASKBOARD_NOT_INSTALLED };
        const answer = await sdk.plugins.callRpc({
          pluginId: TASKBOARD_PLUGIN_ID,
          method: "boards_list",
          input: {},
          outputSchema: boardsSchema,
        });
        const parsed = boardsSchema.safeParse(answer);
        if (!parsed.success) return { unavailable: TASKBOARD_UNAVAILABLE };
        return {
          boards: parsed.data.boards
            .filter((board) => board.connectionId === null)
            .map((board) => ({ id: board.id, name: board.name })),
        };
      } catch {
        return { unavailable: TASKBOARD_UNAVAILABLE };
      }
    },

    async create(boardId, title, description) {
      try {
        if (!(await available())) return { unavailable: TASKBOARD_NOT_INSTALLED };
      } catch {
        return { unavailable: TASKBOARD_UNAVAILABLE };
      }
      try {
        const answer = await sdk.plugins.callRpc({
          pluginId: TASKBOARD_PLUGIN_ID,
          method: "task_create",
          input: { boardId, title, description },
          outputSchema: createdSchema,
        });
        const parsed = createdSchema.safeParse(answer);
        if (!parsed.success) return { uncertain: TASKBOARD_MAYBE_CREATED };
        return { taskId: parsed.data.task.id };
      } catch (error) {
        if (error instanceof experimental_PluginRpcCallError && TASKBOARD_REFUSALS.has(error.code)) {
          return { refused: oneLine(error.message) };
        }
        if (error instanceof experimental_PluginRpcCallError && NOT_SENT_CODES.has(error.code)) {
          return { unavailable: TASKBOARD_UNAVAILABLE };
        }
        return { uncertain: TASKBOARD_MAYBE_CREATED };
      }
    },
  };
}

function oneLine(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (line === "" ? "The request was refused" : line).slice(0, MESSAGE_MAX);
}
