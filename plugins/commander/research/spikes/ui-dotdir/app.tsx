// Stage 0 spike: @dotdirfm/ui inside a BB navPanel. The probe bar records
// whether keys pressed OUTSIDE the DotDir root reach BB untouched.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { DotDir } from "@dotdirfm/ui";
import "@dotdirfm/ui/dotdir.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { createFakeBridge } from "./fake-bridge.ts";

type Row = { key: string; target: string; insideRoot: boolean; defaultPrevented: boolean; propagated: boolean };

// Registered at module load, before DotDir mounts: window-capture listeners
// run in registration order, so this one sees every key first.
type Seen = { key: string; target: string; insideRoot: boolean };
const pending = new Map<KeyboardEvent, Seen>();
let rootEl: HTMLElement | null = null;
let push: (r: Row) => void = () => {};
const describe = (e: KeyboardEvent): Seen => {
  const t = e.target as HTMLElement | null;
  return { key: e.key, target: t?.dataset?.probe ?? t?.tagName ?? "?", insideRoot: !!(t && rootEl?.contains(t)) };
};
window.addEventListener("keydown", (e) => {
  pending.set(e, describe(e));
  setTimeout(() => { const s = pending.get(e); if (s) { pending.delete(e); push({ ...s, defaultPrevented: e.defaultPrevented, propagated: false }); } }, 0);
}, true);
window.addEventListener("keydown", (e) => {
  const s = pending.get(e) ?? describe(e); pending.delete(e);
  push({ ...s, defaultPrevented: e.defaultPrevented, propagated: true });
}, false);

function Probe({ rootRef }: { rootRef: React.RefObject<HTMLDivElement | null> }) {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => { rootEl = rootRef.current; push = (r) => setRows((x) => [r, ...x].slice(0, 16)); return () => { push = () => {}; }; }, [rootRef]);
  return (
    <div data-testid="probe" style={{ padding: 8, borderBottom: "1px solid var(--border)", fontFamily: "monospace", fontSize: 12 }}>
      <label>Внешний ввод (как composer BB): <input data-probe="outside-input" data-testid="outside-input" style={{ width: 240, border: "1px solid var(--border)" }} /></label>
      <table data-testid="probe-log"><tbody>
        {rows.map((r, i) => <tr key={i}><td>{r.key}</td><td>{r.target}</td><td>{r.insideRoot ? "inside" : "outside"}</td><td>{r.defaultPrevented ? "PREVENTED" : "ok"}</td><td>{r.propagated ? "reached-window-bubble" : "STOPPED"}</td></tr>)}
      </tbody></table>
    </div>
  );
}

function Page() {
  const bridge = useMemo(() => createFakeBridge(), []);
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Probe rootRef={rootRef} />
      <div ref={rootRef} data-testid="dotdir-host" style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <DotDir bridge={bridge} widget={null} />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "spike", path: "spike", title: "DotDir spike", icon: "Folder", component: Page });
});
