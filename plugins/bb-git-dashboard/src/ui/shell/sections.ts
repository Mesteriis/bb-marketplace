import type { MessageKey } from "../../core/i18n/dictionary.ts";

export type SectionId = "inbox" | "ci" | "reviews" | "projects" | "catalog" | "connections";
type Section = {id: SectionId; path: string; icon: string; label: MessageKey};

/** The sections of the side column, top to bottom; Connections sits apart at its foot. */
export const sections: Section[] = [
  {id: "inbox", path: "inbox", icon: "GitPullRequest", label: "section.inbox"},
  {id: "ci", path: "ci", icon: "Workflow", label: "section.ci"},
  {id: "reviews", path: "reviews", icon: "FileDiff", label: "section.reviews"},
  {id: "projects", path: "", icon: "FolderGit", label: "section.projects"},
  {id: "catalog", path: "catalog", icon: "Cloud", label: "section.catalog"},
];
export const connections: Section = {id: "connections", path: "connections", icon: "UserRound", label: "section.connections"};

/** The section a dashboard path belongs to: a pull request to My PRs, an issue and a copy's tabs to Projects. */
export function sectionOf(subPath: string): SectionId {
  const head = subPath.split("/")[0] ?? "";
  if (head === "pr" || head === "inbox") return "inbox";
  if (head === "ci" || head === "reviews" || head === "catalog" || head === "connections") return head;
  if (head === "remotes") return "connections";
  return "projects";
}
