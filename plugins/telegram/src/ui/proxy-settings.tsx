import { RefreshCw } from "lucide-react";
import { useTelegramLocale } from "./i18n/index.tsx";
import { useState } from "react";
import { proxyDraft, proxyKind, type ProxyDraft, type TelegramProxy } from "../core/contract.ts";

type ProxyChange = { action: "disable" } | { action: "enable" | "remove"; id: number };
export type ProxyActions = {
  load: () => Promise<TelegramProxy[]>;
  save: (draft: ProxyDraft, id?: number) => Promise<TelegramProxy>;
  change: (input: ProxyChange) => Promise<boolean>;
  ping: (id: number) => Promise<number>;
};

const labels = { socks5: "SOCKS5", http: "HTTP", mtproto: "MTProto" };

export function ProxySettings({ actions }: { actions: ProxyActions }) {
  const { t: tr } = useTelegramLocale();
  const [rows, setRows] = useState<TelegramProxy[]>();
  const [edit, setEdit] = useState<TelegramProxy | "new">();
  const [confirmRemove, setConfirmRemove] = useState<number>();
  const [latency, setLatency] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(work: () => Promise<void>, failure: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await work(); } catch { setError(failure); }
    finally { setBusy(false); }
  }

  const load = async () => setRows(await actions.load());
  async function change(input: ProxyChange) {
    if (!await actions.change(input)) throw new Error("Proxy change not confirmed.");
    setConfirmRemove(undefined);
    await load();
  }

  return <details onToggle={(event) => {
    if (event.currentTarget.open) void run(load, "Could not load Telegram proxies.");
    else { setEdit(undefined); setConfirmRemove(undefined); }
  }}>
    <summary>{tr("Telegram proxy")}</summary>
    {rows?.some(({ enabled }) => enabled) && <button className="mtg-action" type="button" disabled={busy}
      onClick={() => void run(() => change({ action: "disable" }), "Could not switch to a direct connection.")}>{tr("Use direct connection")}</button>}
    {rows?.length === 0 && <p>{tr("No saved proxies.")}</p>}
    {!!rows?.length && <ul aria-label={tr("Saved Telegram proxies")}>{rows.map((row) => <li key={row.id}>
      <strong><bdi>{row.server}</bdi> · {row.port}</strong> · {labels[row.kind]}{row.enabled && tr(" · Active")}
      {latency[row.id] !== undefined && <span> · {latency[row.id]}{tr(" ms")}</span>}
      {confirmRemove === row.id ? <div>
        <button className="mtg-action" type="button" disabled={busy}
          onClick={() => void run(() => change({ action: "remove", id: row.id }), "Could not remove the proxy.")}>{tr("Confirm removal")}</button>
        <button className="mtg-action" type="button" disabled={busy} onClick={() => setConfirmRemove(undefined)}>{tr("Cancel")}</button>
      </div> : <div className="mtg-proxy-actions">
        {!row.enabled && <button className="mtg-action" type="button" disabled={busy}
          onClick={() => void run(() => change({ action: "enable", id: row.id }), "Could not enable the proxy.")}>{tr("Enable")}</button>}
        <button className="mtg-action" type="button" disabled={busy} onClick={() => void run(async () => {
          const ms = await actions.ping(row.id);
          setLatency((previous) => ({ ...previous, [row.id]: ms }));
        }, "Telegram did not respond through that proxy.")}>{tr("Test connection")}</button>
        <button className="mtg-action" type="button" disabled={busy} onClick={() => setEdit(row)}>{tr("Edit proxy")}</button>
        <button className="mtg-action" type="button" disabled={busy} onClick={() => setConfirmRemove(row.id)}>{tr("Remove proxy")}</button>
      </div>}
    </li>)}</ul>}
    {rows && !edit && <button className="mtg-action" type="button" disabled={busy} onClick={() => setEdit("new")}>{tr("Add proxy")}</button>}
    {edit && <ProxyEditor key={edit === "new" ? "new" : edit.id} current={edit === "new" ? undefined : edit} busy={busy}
      save={(draft) => void run(async () => {
        await actions.save(draft, edit === "new" ? undefined : edit.id);
        setEdit(undefined);
        setLatency({});
        await load();
      }, "Could not save the proxy.")} cancel={() => setEdit(undefined)} />}
    {busy && <p role="status">{tr("Updating proxy settings…")}</p>}
    {error && <p role="alert">{tr(error)}</p>}
    <button className="mtg-action" type="button" disabled={busy} onClick={() => void run(load, "Could not load Telegram proxies.")}><RefreshCw size={16} aria-hidden="true" />{tr("Refresh proxies")}</button>
  </details>;
}

function ProxyEditor({ current, busy, save, cancel }: {
  current?: TelegramProxy;
  busy: boolean;
  save: (draft: ProxyDraft) => void;
  cancel: () => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [kind, setKind] = useState<ProxyDraft["kind"]>(current?.kind ?? "socks5");
  const [invalid, setInvalid] = useState(false);
  const keepCredentials = current?.kind === kind;
  return <form className="mtg-proxy-form" onSubmit={(event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const replace = !keepCredentials || form.has("replaceCredentials");
    const username = String(form.get("username") ?? "");
    const password = String(form.get("password") ?? "");
    const secret = String(form.get("secret") ?? "").trim();
    const parsed = proxyDraft.safeParse({
      kind, server: form.get("server"), port: Number(form.get("port")),
      ...(kind === "mtproto" ? { ...(secret && { secret }) } :
        { username: replace || username ? username : undefined, password: replace || password ? password : undefined }),
      ...(kind === "http" && { httpOnly: form.has("httpOnly") }),
    });
    if (!parsed.success || kind === "mtproto" && !keepCredentials && !secret) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    save(parsed.data);
  }}>
    <fieldset disabled={busy}>
      <legend>{current ? tr("Edit proxy") : tr("Add proxy")}</legend>
      <label>{tr("Proxy type ")}<select value={kind} onChange={(event) => {
        const result = proxyKind.safeParse(event.currentTarget.value);
        if (result.success) setKind(result.data);
      }}>
        {proxyKind.options.map((value) => <option key={value} value={value}>{labels[value]}</option>)}
      </select></label>
      <label>{tr("Server ")}<input name="server" required maxLength={253} defaultValue={current?.server} autoComplete="off" /></label>
      <label>{tr("Port ")}<input name="port" type="number" required min={1} max={65535} defaultValue={current?.port} /></label>
      {kind === "mtproto" ? <label>{tr("MTProto secret ")}<input name="secret" type="password" required={!keepCredentials} autoComplete="off" /></label> : <>
        <label>{tr("Username ")}<input name="username" maxLength={255} autoComplete="off" /></label>
        <label>{tr("Password ")}<input name="password" type="password" maxLength={255} autoComplete="off" /></label>
        {keepCredentials && <label><input name="replaceCredentials" type="checkbox" />{tr(" Replace saved credentials, including blank values")}</label>}
        {kind === "http" && <label><input name="httpOnly" type="checkbox" defaultChecked={current?.httpOnly} />{tr(" HTTP only (no CONNECT support)")}</label>}
      </>}
      {keepCredentials && <p>{tr("Leave credential fields blank to keep saved values.")}</p>}
      {invalid && <p role="alert">{tr("Check the server, port and credentials.")}</p>}
      <button className="mtg-action" type="submit">{tr("Save proxy")}</button>
      <button className="mtg-action" type="button" onClick={cancel}>{tr("Cancel")}</button>
    </fieldset>
  </form>;
}
