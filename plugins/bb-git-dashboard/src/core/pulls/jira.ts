// Ported from plugins/bb-github-pr-dashboard/prs.ts (MIT, © 2026 Muhammad Ahsan, revision 898660bc): Jira issue links.
// Pure text work, no I/O: which Jira projects a pull request names, where a key opens, and Markdown with its keys linked.

const JIRA_URL = /^https?:\/\/[\w.-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]{1,9}-\d+)\/?(?:[?#]\S*)?$/;
const JIRA_SITE = /(https?:\/\/[\w.-]+\.atlassian\.net)\/browse\/[A-Z][A-Z0-9]{1,9}-\d+/;

/** Jira project prefixes this PR names (title, branch, Jira URLs), so `UTF-8` or `SHA-256` never become links. */
export function jiraPrefixes(...texts: string[]): Set<string> {
  const prefixes = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-\d+(?![A-Za-z0-9])/g)) {
      const bracketed = new RegExp(`\\[${m[1]}-\\d+\\]|/browse/${m[1]}-\\d+|(?:^|/)${m[1]}-\\d+(?:/|$)`).test(text);
      if (bracketed) prefixes.add(m[1]!);
    }
  }
  return prefixes;
}

/** The Jira site a PR links to, from the first Jira issue URL in it. */
export function jiraSite(...texts: string[]): string | null {
  for (const t of texts) {
    const m = t.match(JIRA_SITE);
    if (m) return m[1]!;
  }
  return null;
}

/** Where a Jira issue key opens: My Jira's ticket page when it runs, else the issue on its site; null when neither is known. */
export function jiraHref(key: string, target: { plugin: boolean; siteUrl: string | null }): string | null {
  if (target.plugin) return `/plugins/my-jira/tickets/${key}`;
  return target.siteUrl ? `${target.siteUrl.replace(/\/+$/, "")}/browse/${key}` : null;
}

/**
 * Markdown with its Jira issues linked: bare keys of the given prefixes become links, and Jira issue URLs
 * point at My Jira when it runs. Code, and text already inside a link, stay as they are.
 */
export function linkJira(markdown: string, prefixes: ReadonlySet<string>, href: (key: string) => string | null, plugin: boolean): string {
  const token = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\[[^\]\n]*\]\([^)\s]*\)|<https?:[^>\s]+>|https?:\/\/[^\s)<>\]]+)/g;
  const keys = prefixes.size > 0 ? new RegExp(`(^|[^A-Za-z0-9/_-])((?:${[...prefixes].join("|")})-\\d+)(?![A-Za-z0-9_-])`, "g") : null;
  const plain = (text: string) =>
    keys ? text.replace(keys, (all, pre: string, key: string) => {
      const to = href(key);
      return to ? `${pre}[${key}](${to})` : all;
    }) : text;
  let out = "";
  let last = 0;
  for (const m of markdown.matchAll(token)) {
    out += plain(markdown.slice(last, m.index));
    const t = m[0];
    if (plugin && t.startsWith("[")) {
      const url = t.slice(t.indexOf("](") + 2, -1);
      const key = url.match(JIRA_URL)?.[1];
      out += key ? `${t.slice(0, t.indexOf("](") + 2)}${href(key)})` : t;
    } else if (plugin && !t.startsWith("`")) {
      const key = t.replace(/^<|>$/g, "").match(JIRA_URL)?.[1];
      out += key ? `[${key}](${href(key)})` : t;
    } else {
      out += t;
    }
    last = m.index! + t.length;
  }
  return out + plain(markdown.slice(last));
}

/** A title as text and keys of the given prefixes, keys at odd indexes; the whole title when no prefix is known. */
export function splitJira(title: string, prefixes: ReadonlySet<string>): string[] {
  if (prefixes.size === 0) return [title];
  return title.split(new RegExp(`((?:${[...prefixes].join("|")})-\\d+)`));
}

/** Where Jira keys open: My Jira when it runs, else this Jira site; the site is null when neither BB nor the PR names it. */
export type JiraTarget = {plugin: boolean; siteUrl: string | null};
/** How one pull request's Jira keys link: the projects it names, and where each key opens. */
export type JiraLinker = {prefixes: ReadonlySet<string>; href(key: string): string | null; plugin: boolean};
export function jiraLinker(pr: {title: string; headRefName: string; body: string}, jira: JiraTarget): JiraLinker {
  const target = {plugin: jira.plugin, siteUrl: jira.siteUrl ?? jiraSite(pr.body)};
  return {prefixes: jiraPrefixes(pr.title, pr.headRefName, pr.body), href: key => jiraHref(key, target), plugin: target.plugin};
}
