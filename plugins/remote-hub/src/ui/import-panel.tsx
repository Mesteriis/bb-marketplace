// The Import screen (stage 3c). Sources are listed but OFF: nothing is read from a file, the agent or
// ssh until the user switches that source on, and ssh -G has its own switch. A scan shows what an
// import would do; only ticked entries are imported, and importing the same source again changes nothing.
import { useCallback, useEffect, useState } from "react";
import type { ImportOutcome, ImportSource, ScanResult } from "../core/import-book.ts";
import { errorTextFromMessage } from "../core/rdp-texts.ts";

export interface ImportApi {
  suggestions: () => Promise<Array<{ kind: ImportSource["kind"]; path: string | null; label: string }>>;
  list: () => Promise<ImportSource[]>;
  add: (input: { kind: ImportSource["kind"]; path: string | null; label: string }) => Promise<ImportSource>;
  set: (input: { id: string; enabled?: boolean; useSshG?: boolean }) => Promise<ImportSource>;
  remove: (id: string) => Promise<{ removed: boolean }>;
  scan: (id: string) => Promise<ScanResult>;
  apply: (id: string, keys?: string[]) => Promise<ImportOutcome>;
}

const FLAG_TEXT: Record<string, string> = {
  proxy: "goes through a proxy or jump host",
  match: "a Match rule may apply",
  tokens: "uses ssh %-tokens",
  canonicalize: "uses hostname canonicalization",
  "host-key-alias": "uses HostKeyAlias",
  "multiple-identities": "only the first key file is imported",
};

const ACTION_TEXT = {
  create: "New",
  update: "Changed in the source",
  unchanged: "Already imported",
  conflict: "Changed here and in the source: left alone",
  "deleted-locally": "Deleted here: not brought back",
  skip: "Cannot be a profile",
} as const;

const KIND_TEXT: Record<ImportSource["kind"], string> = {
  "ssh-config": "SSH config",
  hosts: "Hosts file",
  "keys-dir": "Key files",
  agent: "SSH agent",
};

function outcomeText(o: ImportOutcome): string {
  const parts = [`${o.created} created`, `${o.updated} updated`, `${o.unchanged} unchanged`];
  if (o.conflicts.length > 0) parts.push(`${o.conflicts.length} left alone (changed here and in the source)`);
  if (o.deletedLocally.length > 0) parts.push(`${o.deletedLocally.length} not brought back (deleted here)`);
  if (o.skipped.length > 0) parts.push(`${o.skipped.length} skipped`);
  if (o.markedStale > 0) parts.push(`${o.markedStale} no longer in the source`);
  return parts.join(", ") + ".";
}

export interface ImportPanelProps {
  api: ImportApi;
  /** Called after an import changed profiles. */
  onImported: () => void;
  onClose: () => void;
}

export function ImportPanel({ api, onImported, onClose }: ImportPanelProps) {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ kind: ImportSource["kind"]; path: string | null; label: string }>>([]);
  const [scan, setScan] = useState<{ sourceId: string; result: ScanResult } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }, []);

  const reload = useCallback(async () => {
    setSources(await api.list());
  }, [api]);

  useEffect(() => {
    void run(async () => {
      await reload();
      setSuggestions(await api.suggestions());
    });
  }, [api, reload, run]);

  const doScan = (source: ImportSource, keepMessage = false) =>
    run(async () => {
      if (!keepMessage) setMessage(null);
      const result = await api.scan(source.id);
      setScan({ sourceId: source.id, result });
      if (result.kind === "ssh-config" || result.kind === "hosts") {
        setPicked(new Set(result.items.filter((i) => i.action === "create" || i.action === "update").map((i) => i.key)));
      }
    });

  const registered = new Set((sources ?? []).map((s) => `${s.kind}\u0000${s.path ?? ""}`));
  const unregistered = suggestions.filter((s) => !registered.has(`${s.kind}\u0000${s.path ?? ""}`));

  return (
    <section aria-label="Import" className="rh-import">
      <div className="rh-import-head">
        <h2>Import</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="rh-hint">Nothing is read until you switch a source on. Imported profiles keep their source and can be re-imported safely.</p>
      {problem !== null && <p role="alert" className="rh-error">{problem}</p>}
      {message !== null && <p role="status" className="rh-hint">{message}</p>}

      {sources === null && <p className="rh-hint">Loading…</p>}
      {sources !== null && sources.length === 0 && <p className="rh-hint">No sources yet. Add one below.</p>}
      <ul>
        {(sources ?? []).map((s) => (
          <li key={s.id} aria-label={s.label} className="rh-profile">
            <div className="rh-profile-main">
              <span className="rh-profile-title">
                <strong>{s.label}</strong> <span className="rh-badge">{KIND_TEXT[s.kind]}</span>
              </span>
              {s.path !== null && <span className="rh-profile-endpoint">{s.path}</span>}
              <label className="rh-check">
                <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => void run(async () => { await api.set({ id: s.id, enabled: e.target.checked }); await reload(); if (!e.target.checked && scan?.sourceId === s.id) setScan(null); })} />
                Read this source
              </label>
              {s.kind === "ssh-config" && s.enabled && (
                <label className="rh-check">
                  <input type="checkbox" checked={s.useSshG} disabled={busy} onChange={(e) => void run(async () => { await api.set({ id: s.id, useSshG: e.target.checked }); await reload(); })} />
                  Let ssh -G resolve entries (runs ssh; it evaluates the whole config, including Match exec)
                </label>
              )}
            </div>
            <div className="rh-profile-actions">
              <button type="button" disabled={busy || !s.enabled} aria-label={"Scan " + s.label} onClick={() => void doScan(s)}>
                Scan
              </button>
              <button type="button" disabled={busy} aria-label={"Remove " + s.label} onClick={() => void run(async () => { await api.remove(s.id); if (scan?.sourceId === s.id) setScan(null); await reload(); })}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

      {unregistered.length > 0 && (
        <div>
          <h3>Add a source</h3>
          <ul>
            {unregistered.map((s) => (
              <li key={s.kind + (s.path ?? "")} className="rh-profile">
                <div className="rh-profile-main">
                  <strong>{s.label}</strong>
                  {s.path !== null && <span className="rh-profile-endpoint">{s.path}</span>}
                  <span className="rh-hint">Added switched off.</span>
                </div>
                <div className="rh-profile-actions">
                  <button type="button" disabled={busy} aria-label={"Add " + s.label} onClick={() => void run(async () => { await api.add(s); await reload(); })}>
                    Add
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {scan !== null && (scan.result.kind === "ssh-config" || scan.result.kind === "hosts") && (
        <div aria-label="Scan result">
          <h3>What an import would do</h3>
          {scan.result.items.length === 0 && <p className="rh-hint">Nothing importable in this source.</p>}
          <ul>
            {scan.result.items.map((i) => (
              <li key={i.key} aria-label={i.name} className="rh-profile">
                <label className="rh-check rh-profile-main">
                  <input
                    type="checkbox"
                    checked={picked.has(i.key)}
                    disabled={i.action === "skip" || i.action === "unchanged"}
                    onChange={(e) => setPicked((cur) => { const next = new Set(cur); if (e.target.checked) next.add(i.key); else next.delete(i.key); return next; })}
                  />
                  <span>
                    <strong>{i.name}</strong> <span className="rh-badge">{ACTION_TEXT[i.action]}</span>
                    <br />
                    <span className="rh-profile-endpoint">{(i.username !== null ? i.username + "@" : "") + i.host + (i.port !== null ? ":" + i.port : "")}</span>
                    {i.skip !== null && <span className="rh-error"> {i.skip}</span>}
                    {!i.resolved && <span className="rh-hint"> Uses your SSH config as it is; a password cannot be saved for it.</span>}
                    {i.flags.length > 0 && <span className="rh-hint"> ({i.flags.map((f) => FLAG_TEXT[f] ?? f).join("; ")})</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {scan.result.stale.length > 0 && <p className="rh-hint">No longer in the source: {scan.result.stale.join(", ")}.</p>}
          {scan.result.issues.map((t) => (
            <p key={t} className="rh-hint">{t}</p>
          ))}
          <button
            type="button"
            disabled={busy || picked.size === 0}
            onClick={() =>
              void run(async () => {
                const result = await api.apply(scan.sourceId, [...picked]);
                setMessage(outcomeText(result));
                onImported();
                const source = (sources ?? []).find((s) => s.id === scan.sourceId);
                if (source !== undefined) await doScan(source, true);
              })
            }
          >
            Import selected
          </button>
        </div>
      )}

      {scan !== null && scan.result.kind === "keys-dir" && (
        <div aria-label="Scan result">
          <h3>Public keys found</h3>
          <p className="rh-hint">Only .pub files are read. Private key files are never opened; one that sits beside a public key is named, nothing more.</p>
          {scan.result.keys.length === 0 && <p className="rh-hint">No public keys.</p>}
          <ul>
            {scan.result.keys.map((k) => (
              <li key={k.publicPath} className="rh-profile">
                <div className="rh-profile-main">
                  <strong>{k.publicPath.split("/").pop()}</strong> <span className="rh-badge">{k.type}</span>
                  <span className="rh-profile-endpoint">{k.fingerprint}</span>
                  {k.comment !== "" && <span className="rh-hint">{k.comment}</span>}
                  <span className="rh-hint">{k.privatePath !== null ? "Private file: " + k.privatePath : "No private file beside it"}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {scan !== null && scan.result.kind === "agent" && (
        <div aria-label="Scan result">
          <h3>Keys in the agent</h3>
          {scan.result.keys.length === 0 && <p className="rh-hint">The agent holds no keys{scan.result.issues.length > 0 ? " (" + scan.result.issues.join("; ") + ")" : ""}.</p>}
          <ul>
            {scan.result.keys.map((k) => (
              <li key={k.fingerprint} className="rh-profile">
                <div className="rh-profile-main">
                  <strong>{k.comment || "(no comment)"}</strong> <span className="rh-badge">{k.type} {k.bits}</span>
                  <span className="rh-profile-endpoint">{k.fingerprint}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
