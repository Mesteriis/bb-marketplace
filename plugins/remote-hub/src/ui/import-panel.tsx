// The Import screen (stage 3c). Sources are listed but OFF: nothing is read from a file, the agent or
// ssh until the user switches that source on, and ssh -G has its own switch. A scan shows what an
// import would do; only ticked entries are imported, and importing the same source again changes nothing.
import { useCallback, useEffect, useState } from "react";
import type { ImportOutcome, ImportSource, ScanResult, TrustItem } from "../core/import-book.ts";
import { errorTextFromMessage } from "../core/rdp-texts.ts";

export interface ImportApi {
  suggestions: () => Promise<Array<{ kind: ImportSource["kind"]; path: string | null; label: string }>>;
  list: () => Promise<ImportSource[]>;
  add: (input: { kind: ImportSource["kind"]; path: string | null; label: string }) => Promise<ImportSource>;
  set: (input: { id: string; enabled?: boolean; useSshG?: boolean }) => Promise<ImportSource>;
  remove: (id: string) => Promise<{ removed: boolean }>;
  scan: (id: string) => Promise<ScanResult>;
  apply: (id: string, keys?: string[], scanId?: string) => Promise<ImportOutcome>;
  /** ssh -G for the chosen entries of the reviewed scan; answers with a NEW scan to review. */
  resolve: (id: string, scanId: string, keys: string[]) => Promise<ScanResult>;
  /** What saved-secret SSH sessions trust now (the helper's own known hosts). */
  trusted: () => Promise<Array<Omit<TrustItem, "trusted">>>;
  forget: (host: string) => Promise<{ removed: number }>;
  /** RDP server certificates trusted for good (the "Always trust" answer), and forgetting one. */
  rdpCerts: () => Promise<Array<{ host: string; port: number; fingerprint: string; addedAt: string }>>;
  forgetRdpCert: (host: string, port: number, fingerprint: string) => Promise<{ removed: boolean }>;
}

const FLAG_TEXT: Record<string, string> = {
  proxy: "goes through a proxy or jump host",
  match: "a Match rule may apply",
  tokens: "uses ssh %-tokens",
  canonicalize: "uses hostname canonicalization",
  "host-key-alias": "uses HostKeyAlias",
  "multiple-identities": "only the first key file is imported",
  incomplete: "part of the config could not be read (an Include was refused, missing, cyclic or over the limits)",
};

const ACTION_TEXT = {
  create: "Новое",
  update: "Изменено в источнике",
  unchanged: "Уже импортировано",
  conflict: "Изменено и здесь, и в источнике: не тронуто",
  "deleted-locally": "Удалено здесь: не возвращается",
  skip: "Не может быть подключением",
} as const;

const KIND_TEXT: Record<ImportSource["kind"], string> = {
  "ssh-config": "Конфигурация SSH",
  hosts: "Файл hosts",
  "keys-dir": "Файлы ключей",
  agent: "Агент SSH",
  "known-hosts": "Известные хосты",
};

function outcomeText(o: ImportOutcome): string {
  const parts = [`создано: ${o.created}`, `обновлено: ${o.updated}`, `без изменений: ${o.unchanged}`];
  if (o.conflicts.length > 0) parts.push(`не тронуто (изменено и здесь, и в источнике): ${o.conflicts.length}`);
  if (o.deletedLocally.length > 0) parts.push(`не возвращено (удалено здесь): ${o.deletedLocally.length}`);
  if (o.skipped.length > 0) parts.push(`пропущено: ${o.skipped.length}`);
  if (o.markedStale > 0) parts.push(`больше нет в источнике: ${o.markedStale}`);
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
  const [trusted, setTrusted] = useState<Array<Omit<TrustItem, "trusted">> | null>(null);
  const [rdpCerts, setRdpCerts] = useState<Array<{ host: string; port: number; fingerprint: string; addedAt: string }> | null>(null);
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

  const reloadTrusted = useCallback(async () => {
    try {
      setTrusted(await api.trusted());
    } catch {
      setTrusted([]); // the helper may not be running yet: nothing is trusted that we can show
    }
  }, [api]);

  const reloadRdpCerts = useCallback(async () => {
    try {
      setRdpCerts(await api.rdpCerts());
    } catch {
      setRdpCerts([]);
    }
  }, [api]);

  useEffect(() => {
    void reloadRdpCerts();
    void run(async () => {
      await reload();
      setSuggestions(await api.suggestions());
    });
    void reloadTrusted();
  }, [api, reload, reloadTrusted, reloadRdpCerts, run]);

  const doScan = (source: ImportSource, keepMessage = false) =>
    run(async () => {
      if (!keepMessage) setMessage(null);
      const result = await api.scan(source.id);
      setScan({ sourceId: source.id, result });
      if (result.kind === "ssh-config" || result.kind === "hosts") {
        setPicked(new Set(result.items.filter((i) => i.action === "create" || i.action === "update").map((i) => i.key)));
      } else if (result.kind === "known-hosts") {
        setPicked(new Set());
      }
    });

  const sshGOn = scan !== null && (sources ?? []).some((s) => s.id === scan.sourceId && s.kind === "ssh-config" && s.useSshG);
  const registered = new Set((sources ?? []).map((s) => `${s.kind}\u0000${s.path ?? ""}`));
  const unregistered = suggestions.filter((s) => !registered.has(`${s.kind}\u0000${s.path ?? ""}`));

  return (
    <section aria-label="Импорт" className="rh-import">
      <div className="rh-import-head">
        <h2>Импорт</h2>
        <button type="button" onClick={onClose}>
          Закрыть
        </button>
      </div>
      <p className="rh-hint">Ничего не читается, пока вы не включите источник. Импортированные подключения помнят свой источник, и их можно безопасно импортировать повторно.</p>
      {problem !== null && <p role="alert" className="rh-error">{problem}</p>}
      {message !== null && <p role="status" className="rh-hint">{message}</p>}

      {sources === null && <p className="rh-hint">Загрузка…</p>}
      {sources !== null && sources.length === 0 && <p className="rh-hint">Источников пока нет. Добавьте ниже.</p>}
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
                Читать этот источник
              </label>
              {s.kind === "ssh-config" && s.enabled && (
                <label className="rh-check">
                  <input type="checkbox" checked={s.useSshG} disabled={busy} onChange={(e) => void run(async () => { await api.set({ id: s.id, useSshG: e.target.checked }); await reload(); })} />
                  Разрешить ssh -G для выбранных мной записей. ssh ЗАПУСТИТ локальные команды, названные в этой конфигурации (Match exec), и может читать файлы вне её каталога; его ответ верен только для этого момента и этой сети.
                </label>
              )}
            </div>
            <div className="rh-profile-actions">
              <button type="button" disabled={busy || !s.enabled} aria-label={"Просмотреть: " + s.label} onClick={() => void doScan(s)}>
                Просмотреть
              </button>
              <button type="button" disabled={busy} aria-label={"Убрать: " + s.label} onClick={() => void run(async () => { await api.remove(s.id); if (scan?.sourceId === s.id) setScan(null); await reload(); })}>
                Убрать
              </button>
            </div>
          </li>
        ))}
      </ul>

      {unregistered.length > 0 && (
        <div>
          <h3>Добавить источник</h3>
          <ul>
            {unregistered.map((s) => (
              <li key={s.kind + (s.path ?? "")} className="rh-profile">
                <div className="rh-profile-main">
                  <strong>{s.label}</strong>
                  {s.path !== null && <span className="rh-profile-endpoint">{s.path}</span>}
                  <span className="rh-hint">Добавляется выключенным.</span>
                </div>
                <div className="rh-profile-actions">
                  <button type="button" disabled={busy} aria-label={"Добавить: " + s.label} onClick={() => void run(async () => { await api.add(s); await reload(); })}>
                    Добавить
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {scan !== null && (scan.result.kind === "ssh-config" || scan.result.kind === "hosts") && (
        <div aria-label="Результат просмотра">
          <h3>Что сделает импорт</h3>
          {scan.result.incomplete && (
            <p role="alert" className="rh-error">
              Просмотр неполный: часть источника не удалось прочитать точно. Записи, которых это могло коснуться, не предлагаются как разобранные, и ничто не помечается исчезнувшим.
            </p>
          )}
          {scan.result.items.length === 0 && <p className="rh-hint">В этом источнике нечего импортировать.</p>}
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
                    {i.skip !== null && <span className="rh-error rh-import-note">{i.skip}</span>}
                    {!i.resolved && <span className="rh-hint rh-import-note">Использует вашу конфигурацию SSH как есть; пароль для него сохранить нельзя.</span>}
                    {i.flags.length > 0 && <span className="rh-hint rh-import-note">{i.flags.map((f) => FLAG_TEXT[f] ?? f).join("; ")}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {scan.result.stale.length > 0 && <p className="rh-hint">Больше нет в источнике: {scan.result.stale.join(", ")}.</p>}
          {scan.result.issues.map((t) => (
            <p key={t} className="rh-hint">{t}</p>
          ))}
          {sshGOn && scan.result.items.some((i) => !i.resolved && picked.has(i.key)) && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = scan.result;
                  if (r.kind !== "ssh-config") return;
                  const keys = r.items.filter((i) => !i.resolved && picked.has(i.key)).map((i) => i.key);
                  const next = await api.resolve(scan.sourceId, r.scanId, keys);
                  setScan({ sourceId: scan.sourceId, result: next });
                  setMessage("ssh -G ответил по выбранным записям. Просмотрите их ещё раз перед импортом.");
                })
              }
            >
              Разобрать выбранные записи через ssh -G
            </button>
          )}
          <button
            type="button"
            disabled={busy || picked.size === 0}
            onClick={() =>
              void run(async () => {
                const reviewed = scan.result;
                const result = await api.apply(scan.sourceId, [...picked], reviewed.kind === "ssh-config" || reviewed.kind === "hosts" || reviewed.kind === "known-hosts" ? reviewed.scanId : undefined);
                setMessage(outcomeText(result));
                onImported();
                const source = (sources ?? []).find((s) => s.id === scan.sourceId);
                if (source !== undefined) await doScan(source, true);
              })
            }
          >
            Импортировать выбранное
          </button>
        </div>
      )}

      {scan !== null && scan.result.kind === "known-hosts" && (
        <div aria-label="Результат просмотра">
          <h3>Ключи хостов в этом файле</h3>
          <p className="rh-hint">Отмеченные ключи добавляются к тем, которым Remote Hub доверяет в SSH-сессиях с сохранённым паролем. Без вашей отметки не доверяется ничто.</p>
          {scan.result.items.length === 0 && <p className="rh-hint">В этом файле нет ключей с открытыми именами хостов.</p>}
          <ul>
            {scan.result.items.map((i) => (
              <li key={i.key} aria-label={i.hosts.join(", ") || "хешированный хост " + i.key} className="rh-profile">
                <label className="rh-check rh-profile-main">
                  <input
                    type="checkbox"
                    checked={picked.has(i.key)}
                    disabled={i.trusted}
                    onChange={(e) => setPicked((cur) => { const next = new Set(cur); if (e.target.checked) next.add(i.key); else next.delete(i.key); return next; })}
                  />
                  <span>
                    <strong>{i.hashed ? "(имя хоста хешировано)" : i.hosts.join(", ")}</strong> <span className="rh-badge">{i.keyType}</span>
                    {i.trusted && <span className="rh-badge">уже доверенный</span>}
                    <span className="rh-profile-endpoint rh-import-note">{i.fingerprint}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {scan.result.issues.map((t) => (
            <p key={t} className="rh-hint">{t}</p>
          ))}
          <button
            type="button"
            disabled={busy || picked.size === 0}
            onClick={() =>
              void run(async () => {
                const reviewed = scan.result;
                const result = await api.apply(scan.sourceId, [...picked], reviewed.kind === "known-hosts" ? reviewed.scanId : undefined);
                setMessage(`Добавлено доверенных ключей: ${result.created}, уже были: ${result.unchanged}.`);
                await reloadTrusted();
                const source = (sources ?? []).find((s) => s.id === scan.sourceId);
                if (source !== undefined) await doScan(source, true);
              })
            }
          >
            Доверять выбранным ключам
          </button>
        </div>
      )}

      {scan !== null && scan.result.kind === "keys-dir" && (
        <div aria-label="Результат просмотра">
          <h3>Найденные открытые ключи</h3>
          <p className="rh-hint">Читаются только файлы .pub. Файлы закрытых ключей не открываются никогда; тот, что лежит рядом с открытым, только называется.</p>
          {scan.result.keys.length === 0 && <p className="rh-hint">Открытых ключей нет.</p>}
          <ul>
            {scan.result.keys.map((k) => (
              <li key={k.publicPath} className="rh-profile">
                <div className="rh-profile-main">
                  <strong>{k.publicPath.split("/").pop()}</strong> <span className="rh-badge">{k.type}</span>
                  <span className="rh-profile-endpoint">{k.fingerprint}</span>
                  {k.comment !== "" && <span className="rh-hint">{k.comment}</span>}
                  <span className="rh-hint">{k.privatePath !== null ? "Закрытый ключ: " + k.privatePath : "Закрытого ключа рядом нет"}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div aria-label="Доверенные ключи хостов">
        <h3>Ключи хостов, доверенные для сессий с сохранённым паролем</h3>
        <p className="rh-hint">SSH-сессия с сохранённым паролем в первый раз спрашивает о незнакомом сервере и запоминает ваш ответ здесь. Ваш собственный known_hosts она не читает, пока вы не добавите его выше.</p>
        {trusted !== null && trusted.length === 0 && <p className="rh-hint">Пока нет.</p>}
        <ul>
          {(trusted ?? []).map((t) => (
            <li key={t.key} className="rh-profile">
              <div className="rh-profile-main">
                <strong>{t.hashed ? "(имя хоста хешировано)" : t.hosts.join(", ")}</strong> <span className="rh-badge">{t.keyType}</span>
                <span className="rh-profile-endpoint">{t.fingerprint}</span>
              </div>
              <div className="rh-profile-actions">
                {!t.hashed && t.hosts[0] !== undefined && (
                  <button type="button" disabled={busy} aria-label={"Забыть: " + t.hosts[0]} onClick={() => void run(async () => { await api.forget(t.hosts[0] as string); await reloadTrusted(); })}>
                    Забыть
                  </button>
                )}
                {t.hashed && <span className="rh-hint">Здесь забыть нельзя: имя хоста хешировано, и сопоставить его невозможно.</span>}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div aria-label="Доверенные сертификаты RDP">
        <h3>Сертификаты RDP, которым вы доверяете</h3>
        <p className="rh-hint">Выбраны ответом «Всегда доверять этому сертификату». Другой сертификат на том же сервере, которому этот Mac сам не доверяет, показывается как изменившийся и никогда не принимается автоматически; о сертификате, которому Mac доверяет через свои корневые сертификаты, вопроса нет. Сохранённый пароль RDP отправляется только сертификату, с которым был использован впервые, и это первое использование — доверие с первого взгляда.</p>
        {rdpCerts !== null && rdpCerts.length === 0 && <p className="rh-hint">Пока нет.</p>}
        <ul>
          {(rdpCerts ?? []).map((c) => (
            <li key={c.host + ":" + c.port + ":" + c.fingerprint} className="rh-profile">
              <div className="rh-profile-main">
                <strong>{c.host}:{c.port}</strong>
                <span className="rh-profile-endpoint">{c.fingerprint}</span>
              </div>
              <div className="rh-profile-actions">
                <button type="button" disabled={busy} aria-label={"Забыть сертификат: " + c.host + ":" + c.port} onClick={() => void run(async () => { await api.forgetRdpCert(c.host, c.port, c.fingerprint); await reloadRdpCerts(); })}>
                  Забыть
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {scan !== null && scan.result.kind === "agent" && (
        <div aria-label="Результат просмотра">
          <h3>Ключи в агенте SSH</h3>
          {scan.result.keys.length === 0 && <p className="rh-hint">В агенте нет ключей{scan.result.issues.length > 0 ? " (" + scan.result.issues.join("; ") + ")" : ""}.</p>}
          <ul>
            {scan.result.keys.map((k) => (
              <li key={k.fingerprint} className="rh-profile">
                <div className="rh-profile-main">
                  <strong>{k.comment || "(без комментария)"}</strong> <span className="rh-badge">{k.type} {k.bits}</span>
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
