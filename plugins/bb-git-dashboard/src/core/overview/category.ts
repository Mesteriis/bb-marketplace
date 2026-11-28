// The overview of one category of the projects tree. No I/O.
import { sameRepository } from "../projects/table.ts";
import type { CopyState, RepositoryRuns } from "./items.ts";
import type { InboxPr } from "../pulls/model.ts";

type Input = {mine: InboxPr[]; requested: InboxPr[]; runs: RepositoryRuns[]; copies: CopyState[]; merged?: InboxPr[]};

/**
 * Only the copies of `category` (by `categories`, copy id → category) and the runs and pull requests of the
 * repositories those copies are of (`repositories`, copy id → forge path); a pull request of a repository with no
 * attached copy shows only without a category (null).
 */
export function inCategory<T extends Input>(input: T, category: string | null, categories: Map<string, string>, repositories: Map<string, string>): T {
  if (category === null) return input;
  const here = (copyId: string) => categories.get(copyId) === category;
  const ours = [...categories.keys()].filter(here).flatMap(copyId => repositories.get(copyId) ?? []);
  const own = (path: string) => ours.some(repository => sameRepository(repository, path));
  const pr = (item: InboxPr) => own(item.repo);
  return {...input, runs: input.runs.filter(entry => here(entry.copyId) || own(entry.repository)), copies: input.copies.filter(copy => here(copy.copyId)),
    mine: input.mine.filter(pr), requested: input.requested.filter(pr), ...(input.merged ? {merged: input.merged.filter(pr)} : {})};
}
