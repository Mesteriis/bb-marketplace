import { z } from "zod";
import { gitAction, gitResult, path } from "./git.ts";

export const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const copy = z.object({id, hostId: id, root: path, identity:z.string().regex(/^[a-f0-9]{64}$/),
  repository:id.optional(), repositoryName:z.string().optional(), projectId:id.optional(),
});
export type Copy = z.infer<typeof copy>;
export const operation = z.object({
  id, actor: z.string(), copyId: id, kind: z.string(), at: z.string(),
  state: z.enum(["pending", "succeeded", "failed", "unknown"]),
  code: z.string().optional(),
  before: z.string().nullable().optional(),
  after: z.string().nullable().optional(),
});
export type Operation = z.infer<typeof operation>;

export const request = z.object({copyId: id, action: gitAction, operationId: id.optional()});
export const failure = z.object({ok: z.literal(false), code: z.string(), next: z.string(), operationId: id.optional()});
export type Failure = z.infer<typeof failure>;
export const gitResponse = z.discriminatedUnion("ok", [failure,
  z.object({ok: z.literal(true), value: gitResult, operationId: id.optional()}),
]);

const next: Record<string, string> = {
  TRASH_UNAVAILABLE:"Корзина доступна только на хостах macOS.",
  TRASH_FAILED:"Проверьте папку и доступность системной Корзины на хосте.",
  PROTECTED_FOLDER:"Папка используется другим источником, процессом BB или домашним каталогом.",
  SHARED_WORKTREE:"Сначала разберите связанные worktree этого репозитория.",
  SOURCE_CHANGED:"Источник изменился. Обновите панель и выберите его снова.",
  SOURCE_REJECTED:"BB отклонил удаление источника. Проверьте настройки проекта.",
  INVALID_WORKTREE: "Choose the absolute root of an existing Git worktree.",
  INVALID_PATH: "Select a literal path inside this worktree.",
  STALE_HUNK: "Reload the diff and select the hunk again.",
  STALE_INDEX: "Review the updated index before committing.",
  STALE_HEAD: "Review the current branch and HEAD again.",
  DIRTY_WORKTREE: "Save or commit the current edits before changing branches.",
  INDEX_LOCKED: "Wait for the other Git operation to finish, then refresh.",
  NO_UPSTREAM: "Configure an upstream for this branch.",
  NO_ORIGIN: "Configure an origin for this repository.",
  ACCOUNT_TRANSPORT_REQUIRED: "Choose a provider account for this HTTPS remote.",
  HOST_UNAVAILABLE: "Reconnect the selected BB host and refresh.",
  ACCESS_DENIED: "Grant access in Git Workspace for this thread and worktree.",
  BRANCH_OCCUPIED: "Open the worktree already using this branch.",
  GIT_OUTPUT_LIMIT: "Select a smaller diff or history range.",
  GIT_RESULT_UNKNOWN: "Inspect the repository and remote before retrying.",
  OUTCOME_UNKNOWN: "Inspect the repository or remote before retrying.",
  UNSUPPORTED_REPOSITORY_CONFIG: "Review local Git configuration for includes, external programs, or transport overrides.",
  GIT_SEQUENCE_ACTIVE: "Finish the merge, rebase or cherry-pick before using this commit action.",
  CANCELLED: "The operation was cancelled before execution.",
  AUTHOR_REQUIRED: "Enter the Git author name and email, or set them in this repository’s local Git config.",
  WORKTREE_REPLACED: "The registered worktree changed on disk. Verify the target and attach it again.",
  CREDENTIAL_VAULT_UNAVAILABLE: "Check Credential Vault in BB Settings and retry.",
  CREDENTIAL_VAULT_MISSING: "The saved Vault credential is missing. Restore it before using this connection.",
  CREDENTIAL_BINDING_CHANGED: "The credential is bound to its original provider account and server.",
  NOT_FOUND: "Refresh the catalog and choose an existing entry.",
  PROJECT_REQUIRED: "Attach this working copy to a BB project to hand CI runs to its threads.",
  PROVIDER_CONFLICT: "The forge refused this in the current state of the run. Refresh and try again later.",
  SSH_CONFIG_UNAVAILABLE: "Check the SSH host alias in ~/.ssh/config on the working copy’s host.",
  OPERATION_EXISTS: "Look up the previous operation before starting a new one.",
};
const known = new Set([...Object.keys(next), "INVALID_REMOTE", "GIT_PROCESS_UNAVAILABLE", "GIT_REJECTED",
  "GIT_UNSUPPORTED_ENCODING", "INVALID_BRANCH", "INVALID_DESTINATION", "DESTINATION_EXISTS",
  "UNMERGED_PATH", "NOTHING_STAGED", "INVALID_INPUT", "ACCOUNT_EXISTS", "PROVIDER_DENIED", "PROVIDER_UNAVAILABLE",
  "PROVIDER_REJECTED", "PROVIDER_UNSUPPORTED", "ACCOUNT_UNCONFIGURED", "CREDENTIAL_HELPER_UNAVAILABLE",
  "REMOTE_MISMATCH", "NO_REMOTE_BRANCH", "PREVIEW_EXPIRED", "REPO_LIMIT"]);

export function failureFor(error: unknown, fallback: string, operationId?: string): Failure {
  const reason = error instanceof Error ? error.message : "";
  const code = known.has(reason) ? reason : fallback;
  return {ok: false, code, next: next[code] ?? "Review the selected target and refresh its state.", ...(operationId ? {operationId} : {})};
}
