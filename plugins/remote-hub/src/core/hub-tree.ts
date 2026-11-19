// The connection tree of the sidebar as a flat list of rows: groups, saved connections, and under an opened Proxmox
// connection its nodes and guests. Pure: it gets what was loaded and what the owner typed, and returns what to draw.

export interface TreeProfile {
  id: string;
  name: string;
  protocol: "ssh" | "rdp" | "pve";
  group: string | null;
  /** "user@host" for the row's second line or tooltip. */
  detail: string;
}

export interface TreeGuest {
  vmid: number;
  name: string;
  kind: "lxc" | "qemu";
  node: string;
  status: string;
  template: boolean;
  /** Whether a console can be opened now (a stopped guest or a template has none). */
  available: boolean;
}

export interface TreeConnection {
  /** "ok", or why the lists could not be read (keychain_needs_approval, unreachable, login_failed …). */
  outcome: string;
  nodes: readonly string[];
  guests: readonly TreeGuest[];
}

export type GuestFilter = "all" | "running" | "lxc" | "qemu";

export interface TreeInput {
  profiles: readonly TreeProfile[];
  /** What was read for each Proxmox connection, by profile id; a missing entry means not read yet. */
  connections: Readonly<Record<string, TreeConnection>>;
  /** The Proxmox connections the owner opened. */
  expanded: readonly string[];
  query: string;
  filter: GuestFilter;
}

export type TreeRow =
  | { type: "group"; title: string | null; count: number }
  | { type: "profile"; id: string; name: string; protocol: TreeProfile["protocol"]; detail: string; expanded: boolean; guestCount: number | null }
  | { type: "node"; profileId: string; node: string }
  | ({ type: "guest"; profileId: string } & TreeGuest)
  | { type: "problem"; profileId: string; outcome: string };

const matches = (text: string, needle: string): boolean => text.toLowerCase().includes(needle);

function guestsOf(connection: TreeConnection, filter: GuestFilter, needle: string): TreeGuest[] {
  return connection.guests.filter((g) => {
    if (filter === "running" && g.status !== "running") return false;
    if ((filter === "lxc" || filter === "qemu") && g.kind !== filter) return false;
    return needle === "" || matches(g.name, needle) || String(g.vmid).includes(needle);
  });
}

export function buildTree(input: TreeInput): TreeRow[] {
  const needle = input.query.trim().toLowerCase();
  const groups = new Map<string | null, TreeProfile[]>();
  for (const p of input.profiles) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  const order = [...groups.keys()].sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)));
  const rows: TreeRow[] = [];
  for (const group of order) {
    const section: TreeRow[] = [];
    let shownProfiles = 0;
    for (const p of groups.get(group) ?? []) {
      const connection = p.protocol === "pve" ? input.connections[p.id] : undefined;
      const guests = connection === undefined ? [] : guestsOf(connection, input.filter, needle);
      const nameHit = needle === "" || matches(p.name, needle);
      if (!nameHit && guests.length === 0) continue;
      // A search opens the connection it found guests in; otherwise the owner's choice stands.
      const expanded = p.protocol === "pve" && (needle !== "" ? guests.length > 0 : input.expanded.includes(p.id));
      shownProfiles += 1;
      section.push({ type: "profile", id: p.id, name: p.name, protocol: p.protocol, detail: p.detail, expanded, guestCount: connection === undefined ? null : connection.guests.length });
      if (!expanded || connection === undefined) continue;
      if (connection.outcome !== "ok" && connection.guests.length === 0) {
        section.push({ type: "problem", profileId: p.id, outcome: connection.outcome });
        continue;
      }
      // A node shell is neither a container nor a virtual machine, and a search is for guests.
      if (needle === "" && (input.filter === "all" || input.filter === "running")) for (const node of connection.nodes) section.push({ type: "node", profileId: p.id, node });
      for (const g of guests) section.push({ type: "guest", profileId: p.id, ...g });
    }
    if (shownProfiles === 0) continue;
    rows.push({ type: "group", title: group, count: shownProfiles }, ...section);
  }
  return rows;
}
