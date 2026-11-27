import type { ComponentType, ReactNode } from "react";
import type { OverviewInput } from "../../core/overview/items.ts";

export type OverviewSource = "mine" | "requested" | "merged" | "ci" | "copies";
/** What the overview read: its input, which sources did not answer, how many projects it covers, when. */
export type OverviewData = {input: OverviewInput; failed: OverviewSource[]; copiesFailed: number; projects: number; at: number};
/** Where an item's main action is: a pull request page, a copy's code, or its CI/CD. */
export type OverviewTarget = {kind: "pr"; accountId: string; repo: string; number: number} | {kind: "copy"; copyId: string; section: "code" | "actions"};
export type OverviewApi = {
  /** The overview's data; `refresh` reads every source again instead of this session's copy. */
  load(refresh: boolean): Promise<OverviewData>;
  open(target: OverviewTarget): void;
  /** Saves the view the overview opens with. */
  saveView(view: "list" | "board"): void;
  Link: ComponentType<{href: string; children: ReactNode}>;
};
