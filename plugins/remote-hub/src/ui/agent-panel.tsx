// The owner's view of agent access (stage 4a): which connections agents may use and at what level, and what they
// did. Shows metadata only; the audit never holds terminal text, keystrokes, screenshots or secrets.
import { useCallback, useEffect, useState } from "react";
import type { AgentLevel } from "../core/agent-access.ts";
import { errorTextFromMessage } from "../core/rdp-texts.ts";
import type { RdpCertPromptInfo, RdpDecision, SessionHandle } from "../core/rpc.ts";
import { RdpCertDialog } from "./rdp-cert-dialog.tsx";
import { SshPromptDialog } from "./ssh-prompt.tsx";

export interface AgentGrantView {
  profileId: string;
  level: Exclude<AgentLevel, "none">;
  recordCommands: boolean;
  updatedAt: string;
}
export interface AgentAuditView {
  id: number;
  at: string;
  threadId: string;
  projectId: string;
  tool: string;
  profileId: string | null;
  sessionKey: string | null;
  detailMode: "none" | "length" | "text";
  detail: string | null;
  outcome: string | null;
  count: number;
}

/** A session an agent opened or holds, and what waits for the owner on it (stage 4b-1). */
export interface AgentSessionView {
  generation: string;
  sessionId: number;
  kind: "echo" | "ssh" | "rdp" | "pve" | "vnc";
  connectionId: string | null;
  state: "connecting" | "running" | "closed";
  openedByThread: string | null;
  openedByArchivedThread: boolean;
  holdUntil: number | null;
  controlledBy: "human" | "agent";
  leaseThreadId: string | null;
  leaseExpiresAt: number | null;
  questions: Array<{ kind: "host_key" | "login_prompt"; promptId: number; text: string }>;
  certificate: RdpCertPromptInfo | null;
  /** A person has this session's live view open and visible right now. */
  watching: boolean;
  /** The owner's rule in force: an agent needs a watcher to act. */
  watchingRequired: boolean;
}

export interface AgentApi {
  list: () => Promise<AgentGrantView[]>;
  set: (profileId: string, level: AgentLevel, recordCommands: boolean) => Promise<{ profileId: string; level: AgentLevel; recordCommands: boolean }>;
  revokeAll: () => Promise<{ revoked: number }>;
  audit: (limit: number) => Promise<AgentAuditView[]>;
  sessions: () => Promise<AgentSessionView[]>;
  /** The owner takes a session back from an agent at once. */
  takeover: (handle: SessionHandle) => Promise<{ tookOver: boolean }>;
  /** The owner lets agents drive again before the hold after a takeover has run out. */
  allowAgents: (handle: SessionHandle) => Promise<{ allowed: boolean }>;
  /** The owner's answer to a host-key or login question (null = refuse). */
  answer: (handle: SessionHandle, promptId: number, answer: string | null) => Promise<{ answered: true }>;
  decideCertificate: (handle: SessionHandle, fingerprint: string, accept: RdpDecision) => Promise<void>;
  disconnect: (handle: SessionHandle) => Promise<void>;
  /** The owner's rule: agents act only while the session is watched (default on). */
  settings: () => Promise<{ requireWatching: boolean }>;
  setRequireWatching: (value: boolean) => Promise<{ requireWatching: boolean; changed: boolean }>;
}

export const LEVEL_TEXT: Record<AgentLevel, string> = {
  none: "Нет доступа",
  observe: "Наблюдение: читать вывод и снимки экрана",
  input: "Ввод: наблюдать, подключаться (только с сохранённым паролем) и печатать",
  exec: "Команды: ввод и запуск команд в SSH-сессиях, которые агент открыл сам (каждую команду вы видите сразу)",
};

/** What the owner is told wherever a grant is set. */
export const ACCESS_NOTE =
  "Действует для агентов в ЛЮБОМ треде этого BB. Уровни идут по порядку: нет доступа < наблюдение < ввод < команды; подключаться можно начиная с ввода. " +
  "Агенты никогда не получают сохранённый пароль или ключ, а новый ключ хоста или изменившийся сертификат — всегда ваше решение. " +
  "Но при наблюдении агент читает всё, что печатает терминал (включая уже накопленную прокрутку), и всё, что видно на удалённом экране, в том числе показанный там секрет. " +
  "Уровни ограничивают инструменты, выданные агентам; это не песочница: агент, который запускает команды от вашего имени, всё равно может добраться до плагина.";

export interface AgentPanelProps {
  api: AgentApi;
  /** Names for the profile ids in the lists. */
  profileNames: Map<string, string>;
  onClose: () => void;
}

const outcomeText = (outcome: string | null): string => (outcome === null ? "не завершён (итог не записан)" : outcome);
const detailText = (r: AgentAuditView): string =>
  r.detailMode === "text" ? "команда: " + (r.detail ?? "") : r.detailMode === "length" ? "записана только длина" : "";

export function AgentPanel({ api, profileNames, onClose }: AgentPanelProps) {
  const [grants, setGrants] = useState<AgentGrantView[] | null>(null);
  const [agentSessions, setAgentSessions] = useState<AgentSessionView[] | null>(null);
  const [rows, setRows] = useState<AgentAuditView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requireWatching, setRequireWatching] = useState<boolean | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  const load = useCallback(async () => {
    try {
      setGrants(await api.list());
      setRows(await api.audit(500));
      setAgentSessions(await api.sessions());
      setRequireWatching((await api.settings()).requireWatching);
      setProblem(null);
    } catch (e) {
      setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    }
  }, [api]);
  useEffect(() => {
    void load();
    // Questions and leases change on their own; keep the list current while the screen is open.
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);
  const fail = (e: unknown) => setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
  const act = (run: () => Promise<unknown>) => void run().then(load).catch(fail);

  // Questions are dialogs over the page: only the first session that asks gets one, so two never overlap.
  const asking = (agentSessions ?? []).find((s) => s.questions.length > 0 || s.certificate !== null);
  const changeRule = (value: boolean) => void api.setRequireWatching(value).then((r) => { setRequireWatching(r.requireWatching); setConfirmOff(false); return load(); }).catch(fail);
  const isChange = (r: AgentAuditView) => r.tool.startsWith("access.");
  const changes = (rows ?? []).filter(isChange).slice(0, 20);
  const activity = (rows ?? []).filter((r) => !isChange(r));
  const name = (id: string | null) => (id === null ? "" : (profileNames.get(id) ?? "удалённое подключение"));

  return (
    <section aria-label="Активность агентов" className="rh-import rh-agents">
      <div className="rh-import-head">
        <h2>Доступ и активность агентов</h2>
        <button type="button" onClick={onClose}>
          Закрыть
        </button>
      </div>
      {requireWatching !== null && (
        <div data-testid="watching-rule" className={requireWatching ? "rh-rule rh-rule-on" : "rh-rule rh-rule-off"}>
          <p>
            <strong>Агенты действуют, только пока я смотрю сессию: {requireWatching ? "ВКЛ" : "ВЫКЛ"}</strong>
          </p>
          <p className="rh-hint">
            {requireWatching
              ? "Ввод и команды агента отклоняются, пока у вас не открыт и не виден экран этой сессии; когда вы перестаёте смотреть, управление агента ставится на паузу."
              : "Агент МОЖЕТ действовать, когда никто не смотрит. Баннер, карточка сессии в ответе агента, указатель и список команд остаются, и каждый вызов записывается."}
          </p>
          {!confirmOff && (
            <button type="button" onClick={() => (requireWatching ? setConfirmOff(true) : changeRule(true))}>
              {requireWatching ? "Выключить" : "Включить"}
            </button>
          )}
          {confirmOff && (
            <div role="alertdialog" aria-label="Выключить правило наблюдения" className="rh-rule-confirm">
              <p>Без этого правила агент может действовать, когда на сессию никто не смотрит. Вы всё равно увидите это потом — в баннере и в этом списке.</p>
              <button type="button" onClick={() => changeRule(false)}>
                Да, разрешить агентам действовать без наблюдения
              </button>{" "}
              <button type="button" onClick={() => setConfirmOff(false)}>
                Отмена
              </button>
            </div>
          )}
        </div>
      )}
      <p className="rh-hint">{ACCESS_NOTE}</p>
      {problem !== null && <p className="rh-error" role="alert">{problem}</p>}
      {message !== null && <p role="status" className="rh-hint">{message}</p>}

      <h3>Изменения доступа</h3>
      <p className="rh-hint">Здесь записано каждое изменение доступа и каждый общий отзыв, сначала новые.</p>
      {rows !== null && changes.length === 0 && <p className="rh-hint">Доступ ещё не менялся.</p>}
      <ul aria-label="Изменения доступа">
        {changes.map((r) => (
          <li key={r.id} className="rh-profile">
            <div className="rh-profile-main">
              <strong>{r.tool === "access.revoke_all" ? "Отозван весь доступ" : r.tool === "access.require_watching" ? "Правило наблюдения" : "Доступ изменён"}</strong> <span className="rh-badge">{outcomeText(r.outcome)}</span>
              <span className="rh-profile-endpoint">
                {r.at} · кем: {r.threadId}
                {r.profileId !== null ? " · " + name(r.profileId) : ""}
                {r.detail !== null ? " · " + r.detail : ""}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <h3>Сессии, которые агенты открыли или ведут</h3>
      <p className="rh-hint">На новый ключ хоста, изменившийся ключ, сертификат или вопрос входа в сессии агента отвечаете вы — здесь. Агент узнаёт только, что ждёт вас.</p>
      {agentSessions !== null && agentSessions.length === 0 && <p className="rh-hint">Ни один агент не открыл и не ведёт сессию.</p>}
      <ul aria-label="Сессии агентов">
        {(agentSessions ?? []).map((s) => {
          const handle = { generation: s.generation, sessionId: s.sessionId };
          const label = s.connectionId === null ? "сессия" : name(s.connectionId);
          return (
            <li key={`${s.generation}.${s.sessionId}`} className="rh-profile">
              <div className="rh-profile-main">
                <strong>{label}</strong> <span className="rh-badge">{s.state}</span>
                <span className="rh-profile-endpoint">
                  {s.kind}
                  {s.openedByThread !== null ? (s.openedByArchivedThread ? ` · открыта архивным тредом (${s.openedByThread})` : ` · открыта тредом агента ${s.openedByThread}`) : ""}
                  {" · "}
                  {[
                    s.holdUntil !== null ? `удерживаете вы до ${new Date(s.holdUntil).toLocaleTimeString()}` : null,
                    s.watching ? "вы смотрите" : s.watchingRequired ? "никто не смотрит: агент не может действовать" : "никто не смотрит (ваша настройка разрешает агенту действовать)",
                    s.controlledBy === "agent" ? `управляет агент (тред ${s.leaseThreadId ?? "?"}${s.leaseExpiresAt !== null ? ", до " + new Date(s.leaseExpiresAt).toLocaleTimeString() : ""})` : "управляете вы",
                  ]
                    .filter((part): part is string => part !== null)
                    .join(" · ")}
                </span>
              </div>
              <div className="rh-profile-actions">
                {s.controlledBy === "agent" && (
                  <button type="button" aria-label={"Взять управление: " + label} onClick={() => act(() => api.takeover(handle))}>
                    Взять управление
                  </button>
                )}
                {s.holdUntil !== null && (
                  <button type="button" aria-label={"Снова разрешить агентам: " + label} onClick={() => act(() => api.allowAgents(handle))}>
                    Снова разрешить агентам
                  </button>
                )}
                {s.state !== "closed" && (
                  <button type="button" aria-label={"Отключить: " + label} onClick={() => act(() => api.disconnect(handle))}>
                    Отключить
                  </button>
                )}
              </div>
              {(s.questions.length > 0 || s.certificate !== null) && s !== asking && <p className="rh-hint">В этой сессии вас ждёт вопрос; он откроется после ответа на предыдущий.</p>}
              {s === asking && s.questions[0] !== undefined && (
                <SshPromptDialog prompt={{ promptId: s.questions[0].promptId, text: s.questions[0].text, kind: s.questions[0].kind === "host_key" ? "confirm" : "secret" }} onAnswer={(promptId, answer) => act(() => api.answer(handle, promptId, answer))} />
              )}
              {s === asking && s.questions[0] === undefined && s.certificate !== null && <RdpCertDialog prompt={s.certificate} onDecide={(fingerprint, accept) => act(() => api.decideCertificate(handle, fingerprint, accept))} />}
            </li>
          );
        })}
      </ul>

      <h3>Подключения, разрешённые агентам</h3>
      {grants !== null && grants.length === 0 && <p className="rh-hint">Нет ни одного. Агенты не видят и не используют подключения. Доступ задаётся в настройках подключения.</p>}
      <ul aria-label="Разрешённые подключения">
        {(grants ?? []).map((g) => (
          <li key={g.profileId} className="rh-profile">
            <div className="rh-profile-main">
              <strong>{name(g.profileId)}</strong> <span className="rh-badge">{g.level}</span>
              {g.recordCommands && <span className="rh-hint">команды записываются в список активности</span>}
            </div>
            <div className="rh-profile-actions">
              <button
                type="button"
                disabled={busy}
                aria-label={"Отозвать доступ: " + name(g.profileId)}
                onClick={() => {
                  setBusy(true);
                  void api
                    .set(g.profileId, "none", false)
                    .then(load)
                    .catch((e) => setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e))))
                    .finally(() => setBusy(false));
                }}
              >
                Отозвать
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="rh-editor-actions">
        <button
          type="button"
          disabled={busy || grants === null || grants.length === 0}
          onClick={() => {
            setBusy(true);
            void api
              .revokeAll()
              .then(async (r) => {
                setMessage(`Доступ агентов выключен, подключений: ${r.revoked}.`);
                await load();
              })
              .catch((e) => setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e))))
              .finally(() => setBusy(false));
          }}
        >
          Отозвать весь доступ агентов
        </button>
        <button type="button" disabled={busy} onClick={() => void load()}>
          Обновить
        </button>
      </div>

      <h3>Недавняя активность агентов</h3>
      <p className="rh-hint">Сначала новые, хранятся последние 5000 вызовов. Вызов записывается до выполнения; «не завершён» значит, что итог так и не пришёл.</p>
      {rows !== null && activity.length === 0 && <p className="rh-hint">Агенты ещё не вызывали инструменты Remote Hub.</p>}
      <ul aria-label="Список активности агентов">
        {activity.map((r) => (
          <li key={r.id} className="rh-profile">
            <div className="rh-profile-main">
              <strong>{r.tool}</strong> <span className="rh-badge">{outcomeText(r.outcome)}</span>
              {r.count > 1 && <span className="rh-badge">×{r.count}</span>}
              <span className="rh-profile-endpoint">
                {r.at} · тред {r.threadId} · проект {r.projectId}
                {r.profileId !== null ? " · " + name(r.profileId) : ""}
                {r.sessionKey !== null ? " · сессия " + r.sessionKey : ""}
              </span>
              {detailText(r) !== "" && <span className="rh-hint">{detailText(r)}</span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
