import type { ComponentType, ReactNode } from "react";
import type { OverviewInput } from "../../core/overview/items.ts";
import type { InboxPr } from "../../core/pulls/model.ts";

export type OverviewSource = "mine" | "requested" | "merged" | "ci" | "copies";
/**
 * What the overview read: its input (merged pull requests come separately, for the board), which sources did not
 * answer, how many copies it covers and whether some were left out, when.
 */
export type OverviewData = {input: Omit<OverviewInput, "merged">; failed: OverviewSource[]; copiesFailed: number; copies: number; limited: number | null; at: number};
/** Where an item's main action is: a pull request page, a copy's code, or its CI/CD. */
export type OverviewTarget = {kind: "pr"; accountId: string; repo: string; number: number} | {kind: "copy"; copyId: string; section: "code" | "actions"};
export type OverviewApi = {
  /** The overview's data; `refresh` reads every source again instead of this session's recent copy. */
  load(refresh: boolean): Promise<OverviewData>;
  /** My pull requests merged lately, for the board; null when they could not be read. */
  merged(refresh: boolean): Promise<InboxPr[] | null>;
  open(target: OverviewTarget): void;
  /** Saves the view the overview opens with; rejects when the setting was not written. */
  saveView(view: "list" | "board"): Promise<void>;
  Link: ComponentType<{href: string; children: ReactNode}>;
};
