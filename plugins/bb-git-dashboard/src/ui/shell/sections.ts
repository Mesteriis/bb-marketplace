import type { MessageKey } from "../../core/i18n/dictionary.ts";

export type SectionId = "overview" | "inbox" | "ci" | "reviews" | "projects" | "catalog" | "connections";
type Section = {id: SectionId; path: string; icon: string; label: MessageKey};

/** The sections of the side column, top to bottom; Connections sits apart at its foot. */
export const sections: Section[] = [
  {id: "overview", path: "", icon: "GridView", label: "section.overview"},
  {id: "inbox", path: "inbox", icon: "GitPullRequest", label: "section.inbox"},
  {id: "ci", path: "ci", icon: "Workflow", label: "section.ci"},
  {id: "reviews", path: "reviews", icon: "FileDiff", label: "section.reviews"},
  {id: "projects", path: "projects", icon: "FolderGit", label: "section.projects"},
  {id: "catalog", path: "catalog", icon: "Cloud", label: "section.catalog"},
];
export const connections: Section = {id: "connections", path: "connections", icon: "UserRound", label: "section.connections"};

/** The section a dashboard path belongs to: the empty path is the overview, a pull request My PRs, a copy's tabs Projects. */
export function sectionOf(subPath: string): SectionId {
  if (subPath === "") return "overview";
  const head = subPath.split("/")[0] ?? "";
  if (head === "pr" || head === "inbox") return "inbox";
  if (head === "ci" || head === "reviews" || head === "catalog" || head === "connections") return head;
  // The address of the former Remote repositories screen opens the Catalog's remote tab.
  if (head === "remotes") return "catalog";
  // A run of a copy (`<copy>/actions/<run>`) is a CI/CD page, its path leads back there.
  const [, second, third] = subPath.split("/");
  if (second === "actions" && third && third !== "templates") return "ci";
  return "projects";
}
