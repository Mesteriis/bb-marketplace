// A monitoring alert in a mail (slice 3g, #80): name, state, severity,
// service and links (as their URLs), and one incident thread per alert: Open
// incident thread starts it in a chosen project; a later mail of the same
// alert offers Add to incident thread. Every text comes from the server,
// redacted, and shows as plain text.
import { useEffect, useState } from "react";
import type { AlertViewResult, IncidentPrepareOutput } from "../core/contract.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { BB_TEXT, errorText, useProjects, type BbCall } from "./bb-ports.ts";
import { PreparedPrompt } from "./bb-thread-dialog.tsx";
import { ProjectSelect } from "./project-chip.tsx";

export interface AlertCardProps {
  messageId: string;
  inAiScope: boolean;
  /** The conversation's project, preselected. */
  projectId: string | null;
  call: BbCall;
  onOpenThread: (bbThreadId: string) => void;
  onOpenLink: (url: string) => void;
  onStarted: (bbThreadId: string) => void;
  onAppended: (bbThreadId: string) => void;
}

export function AlertCard(props: AlertCardProps) {
  const { call, messageId } = props;
  const [view, setView] = useState<AlertViewResult | null>(null);
  const [serial, setSerial] = useState(0);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    call("alert_view", { messageId }).then(
      (found) => {
        if (live) setView(found);
      },
      () => {
        if (live) setView({ alert: null, incident: null });
      },
    );
    return () => {
      live = false;
    };
  }, [call, messageId, serial]);
  if (view === null || view.alert === null) return null;
  const { alert, incident } = view;
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      setSerial((n) => n + 1);
    } catch (error) {
      setProblem(errorText(error, "The incident thread could not be reached"));
    } finally {
      setBusy(false);
    }
  };
  const facts = [alert.state, alert.severity, alert.service !== null ? `service ${alert.service}` : null, alert.environment]
    .filter((f): f is string => f !== null && f !== "");
  return (
    <div role="region" aria-label="Alert" className="flex flex-col gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="AlertTriangle" className={cn("size-3.5", alert.state === "firing" ? "text-destructive" : "text-muted-foreground")} aria-hidden />
        <span className="font-medium text-foreground">{alert.name}</span>
        <span className="text-muted-foreground">{facts.join(" \u00b7 ")}</span>
        <span className="text-muted-foreground">{alert.source}</span>
      </div>
      {alert.links.length > 0 ? (
        <ul aria-label="Alert links" className="flex flex-col gap-0.5">
          {alert.links.map((url) => (
            <li key={url} className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{url}</span>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => props.onOpenLink(url)}>
                Open
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-1" title={props.inAiScope ? undefined : BB_TEXT.out_of_scope}>
        {incident !== null ? (
          <>
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => props.onOpenThread(incident.bbThreadId)}>
              {incident.title !== null ? `Open ${incident.title}` : "Open incident thread"}
            </Button>
            {incident.canAppend ? (
              <Button
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={busy || !props.inAiScope}
                onClick={() =>
                  void run(async () => {
                    const { bbThreadId } = await call("incident_append", { messageId });
                    props.onAppended(bbThreadId);
                  })
                }
              >
                Add to incident thread
              </Button>
            ) : null}
          </>
        ) : (
          <Button size="sm" className="h-6 px-2 text-xs" disabled={!props.inAiScope} aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
            {"Open incident thread\u2026"}
          </Button>
        )}
      </div>
      {!props.inAiScope ? <p className="text-muted-foreground">{BB_TEXT.out_of_scope}</p> : null}
      {picking && incident === null ? (
        <IncidentPicker
          call={call}
          messageId={messageId}
          projectId={props.projectId}
          busy={busy}
          onStart={(projectId, promptRef) =>
            void run(async () => {
              const { bbThreadId } = await call("incident_start", { messageId, projectId, promptRef });
              setPicking(false);
              props.onStarted(bbThreadId);
            })
          }
        />
      ) : null}
      {problem !== null ? (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

type Prepared = { status: "loading" } | { status: "ready"; value: IncidentPrepareOutput } | { status: "error"; error: string };

/** The project, then the exact prompt and permission mode the thread starts with; Start sends that prompt. */
function IncidentPicker({
  call,
  messageId,
  projectId: initial,
  busy,
  onStart,
}: {
  call: BbCall;
  messageId: string;
  projectId: string | null;
  busy: boolean;
  onStart: (projectId: string, promptRef: string) => void;
}) {
  const { projects } = useProjects(call);
  const [projectId, setProjectId] = useState<string | null>(initial);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  useEffect(() => {
    if (projectId === null) return;
    let live = true;
    setPrepared({ status: "loading" });
    call("incident_prepare", { messageId, projectId }).then(
      (value) => {
        if (live) setPrepared({ status: "ready", value });
      },
      (error: unknown) => {
        if (live) setPrepared({ status: "error", error: errorText(error, "The prompt could not be prepared") });
      },
    );
    return () => {
      live = false;
    };
  }, [call, messageId, projectId]);
  const ready = prepared?.status === "ready" ? prepared.value : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <ProjectSelect label="Project" projects={projects} value={projectId} onChange={setProjectId} />
        </div>
        <Button
          size="sm"
          className="h-8 px-2"
          disabled={busy || projectId === null || ready === null}
          onClick={() => projectId !== null && ready !== null && onStart(projectId, ready.promptRef)}
        >
          Start incident thread
        </Button>
      </div>
      {prepared?.status === "loading" ? <p role="status" className="text-muted-foreground">{"Preparing the prompt\u2026"}</p> : null}
      {prepared?.status === "error" ? <p role="alert" className="text-destructive">{prepared.error}</p> : null}
      {ready !== null ? <PreparedPrompt prepared={ready} testId="incident-prompt" /> : null}
    </div>
  );
}
