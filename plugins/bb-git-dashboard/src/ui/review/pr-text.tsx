import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { jiraLinker, linkJira, splitJira, type JiraLinker, type JiraTarget } from "../../core/pulls/jira.ts";
import type { ReviewApi } from "./review-api.ts";

type Text = {api: Pick<ReviewApi, "Markdown" | "Link">; jira: JiraLinker | null};
const TextContext = createContext<Text | null>(null);
// Asked once per page load: whether My Jira runs does not change while the PR page is open.
let asked: Promise<JiraTarget> | null = null;

/** Gives the page's forge text BB's Markdown, and its Jira keys their links once My Jira has answered. */
export function PrText({api, pr, children}: {api: ReviewApi; pr: {title: string; headRefName: string; body: string}; children: ReactNode}) {
  const [target, setTarget] = useState<JiraTarget | null>(null);
  useEffect(() => {
    // A failed answer is not kept: the next page asks again (My Jira may start later).
    asked ??= api.jira().catch(() => { asked = null; return {plugin: false, siteUrl: null}; });
    let live = true;
    void asked.then(value => { if (live) setTarget(value); });
    return () => { live = false; };
  }, [api]);
  const value = useMemo<Text>(() => ({api, jira: target ? jiraLinker(pr, target) : null}), [api, target, pr.title, pr.headRefName, pr.body]);
  return <TextContext.Provider value={value}>{children}</TextContext.Provider>;
}

/** A description or comment: Markdown, with the Jira keys of the projects the PR names as links. */
export function PrBody({content}: {content: string}) {
  const text = useContext(TextContext);
  if (!text) return <p className="git-review-body">{content}</p>;
  const {api: {Markdown}, jira} = text;
  return <div className="git-review-markdown"><Markdown content={jira ? linkJira(content, jira.prefixes, jira.href, jira.plugin) : content}/></div>;
}

/** A pull request title with its Jira keys as links. */
export function PrTitle({title}: {title: string}) {
  const text = useContext(TextContext);
  if (!text?.jira) return <>{title}</>;
  const {api: {Link}, jira} = text;
  return <>{splitJira(title, jira.prefixes).map((part, index) => {
    const href = index % 2 === 1 ? jira.href(part) : null;
    return href ? <Link key={index} href={href}>{part}</Link> : part;
  })}</>;
}
