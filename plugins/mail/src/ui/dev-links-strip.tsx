// Repository, PR, issue and CI links of a message (slice 3g, #36), listed by
// their real URL (never the anchor text), with Open, Open project when the
// repository maps to a BB project, and New thread... in that project.
import type { DevLinkView } from "../core/model.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { tx } from "./i18n/index.ts";

const KIND_LABEL: Record<DevLinkView["kind"], string> = {
  repo: "Repository",
  pr: "PR",
  mr: "MR",
  issue: "Issue",
  commit: "Commit",
  run: "CI run",
  pipeline: "Pipeline",
  release: "Release",
  compare: "Compare",
  tracker: "Issue",
};

/** "PR #42 example-org/demo". */
export function linkLabel(link: DevLinkView): string {
  const kind = KIND_LABEL[link.kind];
  const number = link.number === null ? "" : link.kind === "commit" ? ` ${link.number.slice(0, 7)}` : link.kind === "tracker" || link.kind === "release" ? ` ${link.number}` : ` #${link.number}`;
  const repo = link.repo !== null ? ` ${link.repo.path}` : "";
  return `${kind}${number}${repo}`;
}

export interface DevLinksStripProps {
  links: readonly DevLinkView[];
  projectName: (projectId: string) => string;
  onOpen: (url: string) => void;
  onOpenProject: (projectId: string) => void;
  /** New thread... in the link's project with "Look at <url>". */
  onNewThread: (link: DevLinkView) => void;
  inAiScope: boolean;
}

export function DevLinksStrip({ links, projectName, onOpen, onOpenProject, onNewThread, inAiScope }: DevLinksStripProps) {
  if (links.length === 0) return null;
  return (
    <ul aria-label={tx("Links")} className="flex flex-col gap-0.5 text-xs">
      {links.map((link) => (
        <li key={link.url} className="flex min-w-0 flex-wrap items-center gap-1">
          <Icon name="Link" fallback="Paperclip" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="shrink-0 text-foreground">{linkLabel(link)}</span>
          {link.projectId !== null ? (
            <span className="shrink-0 text-muted-foreground">{`(project ${projectName(link.projectId)})`}</span>
          ) : null}
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={link.url}>
            {link.url}
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onOpen(link.url)}>
            {tx("Open")}
          </Button>
          {link.projectId !== null ? (
            <>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onOpenProject(link.projectId!)}>
                {tx("Open project")}
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={!inAiScope} onClick={() => onNewThread(link)}>
                {tx("New thread\u2026")}
              </Button>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
