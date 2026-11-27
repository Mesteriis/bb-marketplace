import type { Account } from "../providers.ts";

export type RepositoryChoice = {owner: string | null; visibility: "private" | "public"};

/**
 * Whether `owner` can own a new repository on that forge: null is the account's own user (not on Azure, where a
 * repository lives in a project); else a GitHub or Gitea organization, a GitLab group path, or an Azure project name.
 */
export function validOwner(kind: Account["kind"], owner: string | null): boolean {
  if (owner === null) return kind !== "azure";
  if (kind === "github" || kind === "gitea") return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(owner);
  if (kind === "gitlab") return /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(owner) && owner.length <= 255 && !owner.split("/").includes("..");
  return /^[^\\/:*?"<>|;#$+=@\u0000-\u001f]{1,64}$/.test(owner) && !/^\.+$/.test(owner);
}

/** The preview's line for the repository: where it goes and who can read it, a public one spelled out. */
export function repositoryLine(account: Pick<Account, "kind" | "label" | "username">, choice: RepositoryChoice, name: string) {
  const where = (choice.owner ?? account.username) + "/" + name;
  const chosen = choice.visibility === "public" ? "PUBLIC: anyone can read it" : "private";
  const visibility = account.kind === "azure" ? chosen + " (as the Azure project " + choice.owner + ", checked)" : chosen;
  return "New repository · " + account.label + " (" + account.kind + ") · " + where + " · " + visibility;
}
