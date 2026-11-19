// The Credentials screen (stage 3b): what is saved in the Keychain, what each
// credential is for, which profiles use it, and the actions on it. It shows
// metadata only; a password can be changed (typed once, sent, cleared) but is
// never displayed.
import { useState } from "react";
import { errorCodeText, errorTextFromMessage } from "../core/rdp-texts.ts";
import type { CredentialItem, CredentialStateName } from "./use-credentials.ts";

export interface CredentialsPanelProps {
  /** null while loading. */
  items: CredentialItem[] | null;
  error: string | null;
  onCheck: (ref: string) => Promise<{ state: CredentialStateName }>;
  /** "Allow access": macOS may show its own dialog for this item. */
  onAllow?: (ref: string) => Promise<{ state: CredentialStateName }>;
  onAllowAll?: () => Promise<Array<{ label: string; ok: boolean; code: string | null }>>;
  onChange: (ref: string, secret: string) => Promise<void>;
  onDelete: (ref: string) => Promise<void>;
  onRetry: () => void;
  onClose: () => void;
}

const STATE_TEXT: Record<CredentialStateName, string> = {
  present: "Есть в Связке ключей.",
  missing: "В Связке ключей его больше нет: сохраните пароль заново.",
  locked: "Связка ключей «Вход» заблокирована (или macOS не разрешил этой сборке Remote Hub её читать). Разблокируйте её в «Связке ключей», затем нажмите «Разрешить доступ».",
  needs_approval: "macOS не разрешил этой сборке Remote Hub читать этот пароль (помощник обновился). Нажмите «Разрешить доступ» и выберите «Всегда разрешать».",
  denied: "Связка ключей отказала в доступе.",
  unavailable: "Связка ключей недоступна.",
};

function bindText(item: CredentialItem): string {
  if (item.orphaned === true) return "Сохранение не завершилось, и запись в Связке ключей не удалось убрать. Удалите её, чтобы повторить очистку.";
  if (item.bind.type === "key") return item.bind.path;
  const b = item.bind;
  return (b.domain !== null ? b.domain + "\\" : "") + (b.user !== null ? b.user + "@" : "") + b.host + ":" + b.port;
}

function kindText(item: CredentialItem): string {
  if (item.kind === "passphrase") return "Парольная фраза ключа";
  return item.bind.type === "endpoint" ? item.bind.protocol.toUpperCase() + ": пароль" : "Пароль";
}

function Row(props: { item: CredentialItem; onCheck: CredentialsPanelProps["onCheck"]; onAllow: CredentialsPanelProps["onAllow"]; onChange: CredentialsPanelProps["onChange"]; onDelete: CredentialsPanelProps["onDelete"] }) {
  const { item } = props;
  const [state, setState] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [secret, setSecret] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li aria-label={item.label} className="rh-profile">
      <div className="rh-profile-main">
        <span className="rh-profile-title">
          <strong>{item.label}</strong> <span className="rh-badge">{kindText(item)}</span>
        </span>
        <span className="rh-profile-endpoint">{bindText(item)}</span>
        <span className="rh-status">{item.usedBy.length > 0 ? "Используют: " + item.usedBy.map((u) => u.name).join(", ") : "Не используется ни одним подключением"}</span>
        {state !== null && <span className="rh-status">{state}</span>}
        {problem !== null && <span className="rh-error">{problem}</span>}
      </div>
      <div className="rh-profile-actions">
        {item.orphaned !== true && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setState(STATE_TEXT[(await props.onCheck(item.ref)).state]);
              })
            }
          >
            Проверить
          </button>
        )}
        {item.orphaned !== true && props.onAllow !== undefined && (
          <button
            type="button"
            disabled={busy}
            title="macOS спросит один раз; выберите «Всегда разрешать». Пока открыт его диалог, остальные сессии на паузе."
            onClick={() =>
              void run(async () => {
                setState(STATE_TEXT[(await props.onAllow!(item.ref)).state]);
              })
            }
          >
            Разрешить доступ
          </button>
        )}
        {!changing && item.orphaned !== true && (
          <button type="button" onClick={() => setChanging(true)}>
            Сменить пароль
          </button>
        )}
        {changing && (
          <>
            <label>
              Новый пароль
              <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
            <button
              type="button"
              disabled={busy || secret === ""}
              onClick={() => {
                const typed = secret;
                setSecret(""); // gone from the form at once
                void run(async () => {
                  await props.onChange(item.ref, typed);
                  setChanging(false);
                  setState("Пароль изменён.");
                });
              }}
            >
              Сохранить новый пароль
            </button>
            <button
              type="button"
              onClick={() => {
                setSecret("");
                setChanging(false);
              }}
            >
              Отмена
            </button>
          </>
        )}
        {confirming ? (
          <>
            {item.usedBy.length > 0 && <span className="rh-hint">Снова спросят пароль: {item.usedBy.map((u) => u.name).join(", ")}.</span>}
            <button type="button" aria-label="Подтвердить удаление" disabled={busy} onClick={() => void run(async () => props.onDelete(item.ref))}>
              Удалить?
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Оставить
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}>
            Удалить
          </button>
        )}
      </div>
    </li>
  );
}

export function CredentialsPanel(props: CredentialsPanelProps) {
  const [walking, setWalking] = useState(false);
  const [walked, setWalked] = useState<string | null>(null);
  const allowAll = async () => {
    if (props.onAllowAll === undefined) return;
    setWalking(true);
    setWalked(null);
    try {
      const results = await props.onAllowAll();
      const failed = results.filter((r) => !r.ok);
      setWalked(failed.length === 0 ? `Доступ разрешён, сохранённых записей: ${results.length}.` : failed.map((r) => `${r.label}: ${errorCodeText(r.code ?? "keychain_unavailable")}`).join(" "));
    } catch (e) {
      setWalked(errorTextFromMessage(e instanceof Error ? e.message : String(e)));
    } finally {
      setWalking(false);
    }
  };
  return (
    <section className="rh-credentials" aria-label="Сохранённые учётные данные">
      <div className="rh-credentials-head">
        <h2>Учётные данные</h2>
        <button type="button" onClick={props.onClose}>
          Закрыть
        </button>
      </div>
      <p className="rh-hint">Пароли хранятся в Связке ключей macOS. Здесь видно, для чего каждый из них; сам пароль не показывается никогда.</p>
      {props.onAllowAll !== undefined && (
        <p>
          <button type="button" disabled={walking} onClick={() => void allowAll()} title="По одному диалогу macOS на каждую запись; выберите «Всегда разрешать». Пока диалог открыт, остальные сессии на паузе.">
            Разрешить доступ ко всем сохранённым записям
          </button>{" "}
          <span className="rh-hint">После обновления Remote Hub macOS спрашивает по разу на каждую запись.</span>
        </p>
      )}
      {walked !== null && <p role="status" className="rh-hint">{walked}</p>}
      {props.items === null && props.error === null && <p className="rh-hint">Загружаю учётные данные…</p>}
      {props.error !== null && (
        <div>
          <p className="rh-error">{props.error}</p>
          <button type="button" onClick={props.onRetry}>
            Повторить
          </button>
        </div>
      )}
      {props.items !== null && props.items.length === 0 && <p className="rh-hint">Сохранённых паролей пока нет. Сохранить можно в настройках подключения.</p>}
      {props.items !== null && props.items.length > 0 && (
        <ul className="rh-credential-list">
          {props.items.map((item) => (
            <Row key={item.ref} item={item} onCheck={props.onCheck} onAllow={props.onAllow} onChange={props.onChange} onDelete={props.onDelete} />
          ))}
        </ul>
      )}
    </section>
  );
}
