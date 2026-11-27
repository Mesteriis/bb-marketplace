import { useState } from "react";
import { DeskContext } from "./desk/desk-context.tsx";
import { createDeskStore } from "./desk-store.ts";
import { createHubBus } from "./hub-bus.ts";
import { HubPage, type HubPageProps } from "./hub-page.tsx";
import { HubSidebarConnected } from "./sidebar/hub-sidebar-connected.tsx";

type ThreadHubBridge = Required<Omit<HubPageProps, "adoptConsole" | "bus" | "pluginsChanged">>;

export function ThreadHub({ bridge }: { bridge: ThreadHubBridge }) {
  // A thread tab can coexist with the full page and with tabs in other threads.
  const [desk] = useState(createDeskStore);
  const [bus] = useState(createHubBus);
  return (
    <DeskContext.Provider value={desk}>
      <div className="rh-thread-hub h-full min-h-0 bg-background">
        <div className="rh-thread-hub-layout h-full">
          <div className="rh-thread-hub-connections min-h-0 min-w-0">
            <HubSidebarConnected profiles={bridge.profiles} pve={bridge.pve} allow={bridge.credentials.allow} bus={bus} />
          </div>
          <div className="min-h-0 min-w-0">
            <HubPage {...bridge} bus={bus} />
          </div>
        </div>
      </div>
    </DeskContext.Provider>
  );
}
