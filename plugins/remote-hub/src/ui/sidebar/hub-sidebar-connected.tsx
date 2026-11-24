// The sidebar with its data: it loads the saved connections and, for a Proxmox connection the owner opens, its nodes and
// guests; what the owner picks goes to the page through the bus. Host-free: the data sources are passed in.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Profile } from "../../core/profile.ts";
import type { TreeConnection, TreeProfile } from "../../core/hub-tree.ts";
import type { PveConnectionView } from "../../core/pve-targets.ts";
import { closeDeskSession, useDeskStore, useDeskThumbStore } from "../desk/desk-context.tsx";
import { useDesk } from "../desk-store.ts";
import { hubBus as defaultBus, type HubBus } from "../hub-bus.ts";
import type { PveApi } from "../pve-api.ts";
import { useThumbs } from "../thumb-store.ts";
import { useProfiles, type ProfilesApi } from "../use-profiles.ts";
import { HubSidebar } from "./hub-sidebar.tsx";

export interface HubSidebarConnectedProps {
  profiles: ProfilesApi;
  pve?: Pick<PveApi, "targets">;
  /** Asks macOS to let this build read a saved password ("Allow access"). */
  allow?: (credentialRef: string) => Promise<unknown>;
  bus?: HubBus;
}

export function treeProfileOf(p: Profile): TreeProfile {
  const address = p.port === null ? p.host : `${p.host}:${p.port}`;
  return { id: p.id, name: p.name, protocol: p.protocol, group: p.group, detail: p.username === null ? address : `${p.username}@${address}` };
}

export function treeConnectionOf(view: PveConnectionView): TreeConnection {
  return {
    // A connection with nothing in it was read all the same.
    outcome: view.outcome === "empty" ? "ok" : view.outcome,
    nodes: view.nodes.map((n) => n.node),
    guests: view.guests.map((g) => ({ vmid: g.vmid, name: g.name, kind: g.kind, node: g.node, status: g.status, template: g.template, available: g.console.available })),
  };
}

export function HubSidebarConnected({ profiles: api, pve, allow, bus = defaultBus }: HubSidebarConnectedProps) {
  const store = useDeskStore();
  const desk = useDesk(store);
  const thumbs = useThumbs(useDeskThumbStore());
  const data = useProfiles(api);
  const { reload } = data;
  const [views, setViews] = useState<Readonly<Record<string, PveConnectionView>>>({});
  const wanted = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(
    async (profileIds: string[], refresh: boolean) => {
      if (pve === undefined || profileIds.length === 0) return;
      try {
        const { connections } = await pve.targets({ profileIds, refresh });
        if (alive.current) setViews((cur) => ({ ...cur, ...Object.fromEntries(connections.map((c) => [c.profileId, c])) }));
      } catch {
        // The row keeps what was read before; opening the connection again asks again.
      }
    },
    [pve],
  );

  useEffect(
    () =>
      bus.onChanged(() => {
        void reload();
        void read([...wanted.current], true);
      }),
    [bus, reload, read],
  );

  const tree = useMemo(() => (data.profiles === null ? null : data.profiles.map(treeProfileOf)), [data.profiles]);
  const connections = useMemo(() => Object.fromEntries(Object.entries(views).map(([id, v]) => [id, treeConnectionOf(v)])), [views]);
  const nameOf = (profileId: string): string => data.profiles?.find((p) => p.id === profileId)?.name ?? "";

  return (
    <HubSidebar
      profiles={tree}
      error={data.error}
      connections={connections}
      sessions={desk.sessions}
      thumbs={thumbs}
      shown={desk.shown}
      focusedId={desk.focus}
      onFocusSession={(id) => {
        store.focus(id);
        bus.send({ type: "desk" });
      }}
      onCloseSession={(id) => closeDeskSession(store, id)}
      onExpand={(id) => {
        wanted.current.add(id);
        void read([id], false);
      }}
      onConnect={(profileId) => bus.send({ type: "connect", profileId })}
      onConsole={(profileId, request, title) => bus.send({ type: "console", profileId, connectionName: nameOf(profileId), request, title })}
      onEdit={(profileId) => bus.send({ type: "edit", profileId })}
      onAdd={(what) => bus.send(what === "profile" ? { type: "edit", profileId: null } : what === "pve" ? { type: "add-pve" } : { type: "import" })}
      onCredentials={() => bus.send({ type: "credentials" })}
      onAgents={() => bus.send({ type: "agents" })}
      onAllow={(profileId) => {
        const ref = views[profileId]?.credentialRef ?? null;
        if (ref === null || allow === undefined) {
          bus.send({ type: "credentials" });
          return;
        }
        void allow(ref).then(
          () => read([profileId], true),
          () => bus.send({ type: "credentials" }),
        );
      }}
      onGuests={(profileId) => bus.send({ type: "guests", profileId })}
      onRetry={() => void reload()}
    />
  );
}
