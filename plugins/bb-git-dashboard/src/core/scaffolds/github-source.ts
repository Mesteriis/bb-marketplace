/**
 * The templates repository on GitHub: which repository and branch the settings name, and what the plugin knows of
 * it — the revision last read (bound to that repository and branch), when it was last checked and why it failed.
 */

/** The default templates repository and branch. */
export const defaultTemplates = {repository: "Mesteriis/makosh-scaffolds", branch: "main"};

/** owner/name as GitHub allows them. */
export const validRepository = (value: string) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(value) && !/\/\.{1,2}$/.test(value);
/** A branch name Git allows, without the forms that could step out of a URL path. */
export const validBranch = (value: string) => /^[A-Za-z0-9._\/-]{1,200}$/.test(value) && !value.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))
  && !value.endsWith(".lock") && !value.includes("..");

/** The revision of a repository and branch whose archive the plugin holds. */
export type Revision = {repository: string; branch: string; sha: string; committedAt: string; etag: string | null};
/** What the New project form shows about the templates' source. */
export type SourceState = {
  repository: string; branch: string;
  /** The revision held for this repository and branch, if any. */
  revision: {sha: string; committedAt: string} | null;
  /** When GitHub last answered for them. */
  checkedAt: string | null;
  /** Why the last check failed, when it did; the revision held (if any) is still offered. */
  error: {code: string; detail: string} | null;
};

/** The settings as read: trimmed, the default where empty; null when they do not name a repository and branch. */
export function templatesSource(repository: string, branch: string) {
  const chosen = {repository: repository.trim() || defaultTemplates.repository, branch: branch.trim() || defaultTemplates.branch};
  return validRepository(chosen.repository) && validBranch(chosen.branch) ? chosen : null;
}
