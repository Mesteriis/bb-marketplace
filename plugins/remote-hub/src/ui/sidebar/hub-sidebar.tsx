// What BB's sidebar shows while the Remote Hub page is open, instead of the thread list: a search, the sessions that are
// open now, and the saved connections as a tree (a Proxmox connection opens to its node and guests). It draws what it is
// given and reports what the owner picked; loading and the sessions themselves live with the page.
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { DeskSession } from "../../core/desk.ts";
import { toneOf } from "../../core/desk-status.ts";
import { buildTree, type GuestFilter, type TreeConnection, type TreeProfile, type TreeRow } from "../../core/hub-tree.ts";
import { kindText, stateText, StatusDot } from "../desk/status.tsx";
import { plural, tx } from "../i18n.ts";
import type { PveConsoleRequest } from "../pve-api.ts";

export interface HubSidebarProps {
  /** null while the saved connections are loading. */
  profiles: readonly TreeProfile[] | null;
  error: string | null;
  connections: Readonly<Record<string, TreeConnection>>;
  sessions: readonly DeskSession[];
  shown: readonly string[];
  onFocusSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  /** A Proxmox connection was opened in the tree: its guests are wanted. */
  onExpand: (profileId: string) => void;
  onConnect: (profileId: string) => void;
  onConsole: (profileId: string, request: PveConsoleRequest, title: string) => void;
  onEdit: (profileId: string) => void;
  onAdd: (what: "profile" | "pve" | "import") => void;
  onCredentials: () => void;
  onAgents: () => void;
  onAllow: (profileId: string) => void;
  onRetry: () => void;
}

const ROW = "flex h-[var(--rh-row)] w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
/** What ends a row; it gives way to the row's action button while the row is hovered or focused. */
const TRAIL = "flex shrink-0 items-center gap-2 group-focus-within:invisible group-hover:invisible";
const SECTION = "flex items-center justify-between px-2 pb-1.5 pt-3.5 text-xs uppercase tracking-wide text-muted-foreground";
const FILTERS: ReadonlyArray<{ value: GuestFilter; key: "pve.filter.all" | "pve.filter.running" | "pve.filter.lxc" | "pve.filter.vm" }> = [
  { value: "all", key: "pve.filter.all" },
  { value: "running", key: "pve.filter.running" },
  { value: "lxc", key: "pve.filter.lxc" },
  { value: "qemu", key: "pve.filter.vm" },
];
const GUESTS = ["гость", "гостя", "гостей"] as const;

function ProtocolTag({ protocol }: { protocol: TreeProfile["protocol"] }) {
  return <span className="shrink-0 rounded border border-border px-1 text-[10.5px] leading-4 text-muted-foreground">{protocol === "pve" ? "PVE" : protocol.toUpperCase()}</span>;
}

export function HubSidebar(props: HubSidebarProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<GuestFilter>("all");
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const rows = useMemo(
    () => (props.profiles === null ? [] : buildTree({ profiles: props.profiles, connections: props.connections, expanded, query, filter })),
    [props.profiles, props.connections, expanded, query, filter],
  );
  const toggle = (profileId: string): void => {
    const opening = !expanded.includes(profileId);
    setExpanded(opening ? [...expanded, profileId] : expanded.filter((id) => id !== profileId));
    if (opening) props.onExpand(profileId);
  };

  const row = (r: TreeRow, index: number) => {
    switch (r.type) {
      case "group":
        return (
          <div key={`g${index}`} className={SECTION} role="presentation">
            <span>{r.title ?? tx("sidebar.connections")}</span>
            <span>{r.count}</span>
          </div>
        );
      case "profile":
        return (
          <div key={`p${r.id}`} className="group relative">
            <button
              type="button"
              className={ROW}
              title={r.detail}
              aria-expanded={r.protocol === "pve" ? r.expanded : undefined}
              onClick={() => (r.protocol === "pve" ? toggle(r.id) : props.onConnect(r.id))}
            >
              {r.protocol === "pve" && <Icon name={r.expanded ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className={TRAIL}>
                <ProtocolTag protocol={r.protocol} />
                {r.guestCount !== null && <span className="text-xs text-muted-foreground" title={plural(r.guestCount, GUESTS)}>{r.guestCount}</span>}
              </span>
            </button>
            <Button type="button" variant="ghost" size="icon" className="absolute right-0.5 top-1/2 size-7 -translate-y-1/2 opacity-0 focus-visible:opacity-100 group-hover:opacity-100" aria-label={`${tx("sidebar.edit")}: ${r.name}`} onClick={() => props.onEdit(r.id)}>
              <Icon name="Settings" className="size-3.5" />
            </Button>
          </div>
        );
      case "node":
        return (
          <button key={`n${r.profileId}:${r.node}`} type="button" className={cn(ROW, "pl-7")} onClick={() => props.onConsole(r.profileId, { console: "node", node: r.node }, "")}>
            <StatusDot tone="ok" />
            <span className="min-w-0 flex-1 truncate">{tx("pve.node", { name: r.node })}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{tx("kind.nodeShell")}</span>
          </button>
        );
      case "guest":
        return (
          <button
            key={`v${r.profileId}:${r.vmid}`}
            type="button"
            className={cn(ROW, "pl-7", !r.available && "text-muted-foreground")}
            disabled={!r.available}
            title={r.available ? undefined : tx(r.template ? "pve.template" : "pve.stopped")}
            onClick={() => props.onConsole(r.profileId, { console: r.kind, vmid: r.vmid }, r.name)}
          >
            <StatusDot tone={r.available ? "ok" : "idle"} />
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {r.kind === "qemu" ? "VM" : "LXC"} {r.vmid}
            </span>
          </button>
        );
      case "problem":
        return (
          <div key={`e${r.profileId}`} className="flex flex-col gap-1.5 py-1 pl-7 pr-2 text-xs text-muted-foreground" role="status" data-testid="sidebar-problem">
            <span>{r.outcome === "keychain_needs_approval" ? tx("pve.needsApproval") : tx("pve.unreadable", { code: r.outcome })}</span>
            {r.outcome === "keychain_needs_approval" && (
              <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => props.onAllow(r.profileId)}>
                {tx("pve.allow")}
              </Button>
            )}
          </div>
        );
    }
  };

  const hasPve = rows.some((r) => r.type === "profile" && r.protocol === "pve" && r.expanded);
  return (
    <nav className="rh-tokens flex h-full min-h-0 flex-col text-foreground" aria-label={tx("app.title")}>
      <div className="flex h-[var(--rh-header)] shrink-0 items-center gap-2 px-3">
        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tx("sidebar.search")} aria-label={tx("sidebar.search")} className="h-8 flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="icon" className="size-8 shrink-0" aria-label={tx("sidebar.add")}>
              <Icon name="Plus" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => props.onAdd("profile")}>{tx("sidebar.add.profile")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => props.onAdd("pve")}>{tx("sidebar.add.pve")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => props.onAdd("import")}>{tx("sidebar.add.import")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={props.onCredentials}>{tx("sidebar.credentials")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={props.onAgents}>{tx("sidebar.agents")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {props.sessions.length > 0 && (
          <section aria-label={tx("sidebar.open")}>
            <div className={SECTION}>
              <span>{tx("sidebar.open")}</span>
              <span>{props.sessions.length}</span>
            </div>
            {props.sessions.map((s) => (
              <div key={s.id} className="group relative" data-testid="sidebar-session">
                <button type="button" className={cn(ROW, props.shown.includes(s.id) && "bg-accent")} aria-current={props.shown.includes(s.id) ? "true" : undefined} title={`${s.detail} · ${stateText(s)}`} onClick={() => props.onFocusSession(s.id)}>
                  <StatusDot tone={toneOf(s)} />
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <span className={cn(TRAIL, "text-xs text-muted-foreground")}>{s.state === "active" ? kindText(s.kind) : stateText(s)}</span>
                </button>
                <Button type="button" variant="ghost" size="icon" className="absolute right-0.5 top-1/2 size-7 -translate-y-1/2 opacity-0 focus-visible:opacity-100 group-hover:opacity-100" aria-label={`${tx("session.close")}: ${s.title}`} onClick={() => props.onCloseSession(s.id)}>
                  <Icon name="X" className="size-3.5" />
                </Button>
              </div>
            ))}
          </section>
        )}
        {hasPve && (
          <div className="flex flex-wrap gap-1 px-2 pt-3" role="group" aria-label="Proxmox">
            {FILTERS.map((f) => (
              <Button key={f.value} type="button" size="sm" variant="ghost" className="h-6 rounded-full px-2 text-xs" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
                {tx(f.key)}
              </Button>
            ))}
          </div>
        )}
        {props.error !== null && (
          <div className="flex flex-col gap-2 px-2 py-3 text-sm text-muted-foreground" role="alert">
            <span>{props.error}</span>
            <Button type="button" size="sm" variant="outline" className="self-start" onClick={props.onRetry}>
              {tx("pve.refresh")}
            </Button>
          </div>
        )}
        {rows.map(row)}
        {props.profiles !== null && props.error === null && rows.length === 0 && (
          <p className="px-2 py-3 text-sm text-muted-foreground" data-testid="sidebar-empty">
            {tx(query.trim() !== "" ? "sidebar.nothingFound" : "sidebar.empty")}
          </p>
        )}
      </div>
    </nav>
  );
}
