import type { z } from "zod";
import type { IssueAction } from "../../core/issues/model.ts";
import type { PrAction } from "../../core/pulls/actions.ts";
import type { agentSubject, reviewContract } from "../../core/pulls/review-contract.ts";

type Ok<T extends {output: z.ZodType}> = Omit<Extract<z.infer<T["output"]>, {ok: true}>, "ok">;
export type PrView = Ok<typeof reviewContract.prDetail>;
export type PrDetailView = PrView["detail"];
export type PrFileView = Ok<typeof reviewContract.prFiles>["files"][number];
export type IssueView = Ok<typeof reviewContract.issueDetail>["issue"];
export type Preview = {id: string; lines: string[]};
export type PrRef = {accountId: string; repo: string; number: number};
export type ReviewApi = {
  detail(ref: PrRef): Promise<PrView>;
  files(ref: PrRef): Promise<PrFileView[]>;
  prepare(ref: PrRef, action: PrAction): Promise<Preview>;
  confirm(previewId: string): Promise<{outcome: "completed" | "accepted"}>;
  ask(ref: PrRef, subject: z.infer<typeof agentSubject>): Promise<{threadId: string; created: boolean}>;
  openThread(threadId: string): void;
  issue(ref: PrRef): Promise<IssueView>;
  issuePrepare(accountId: string, repo: string, action: IssueAction): Promise<Preview>;
  issueConfirm(previewId: string): Promise<{number: number}>;
};

export const message = (error: unknown) => error instanceof Error ? error.message : "Request failed.";
/** `pr/<account>/<repo>/<number>` and `issue/…`: the repository path is one encoded segment. */
export const refPath = (kind: "pr" | "issue", ref: {accountId: string; repo: string; number: number | "new"}) =>
  kind + "/" + encodeURIComponent(ref.accountId) + "/" + encodeURIComponent(ref.repo) + "/" + ref.number;
export function parseRef(subPath: string): {kind: "pr" | "issue"; accountId: string; repo: string; number: number | "new"} | null {
  const [kind, account, repo, number] = subPath.split("/");
  if ((kind !== "pr" && kind !== "issue") || !account || !repo || !number) return null;
  try {
    const parsed = number === "new" && kind === "issue" ? "new" as const : Number(number);
    if (parsed !== "new" && (!Number.isSafeInteger(parsed) || parsed < 1)) return null;
    return {kind, accountId: decodeURIComponent(account), repo: decodeURIComponent(repo), number: parsed};
  } catch { return null; }
}
