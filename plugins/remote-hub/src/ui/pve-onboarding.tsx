// Adding a Proxmox connection, two ways.
//  1. A restricted user (recommended): the administrator's login is used for this one setup and is never stored. The
//     screen first asks Proxmox what it would do and shows exactly what will be created, then waits for a confirmation.
//     The new user's password goes straight into the Keychain from the helper; this screen never sees it.
//  2. Connect as is: the typed password or API token is saved for this connection, and nothing is created in Proxmox.
// A certificate that is not trusted shows its fingerprint and waits for the owner to confirm it.
import { useState } from "react";
import { PVE_PROVISION, type PvePlan, type PveSteps } from "../core/pve-protocol.ts";
import type { PveProfileTrust } from "../core/pve-trust.ts";
import { adviceFor, outcomeOfFailure } from "../core/pve-targets.ts";
import type { PveAdminInput, PveApi, PveFailure } from "./pve-api.ts";

export interface PveOnboardingProps {
  api: PveApi;
  onDone: (profileId: string) => void;
  onCancel: () => void;
}

type Mode = "restricted" | "as_is";

const USER_ID = /^[A-Za-z0-9._-]{1,64}@pve$/;

const ROLE_TEXT: Record<PvePlan["role"], string> = {
  create: "будет создана",
  keep: "уже существует ровно с этими правами; остаётся как есть",
  differs: "существует с другими правами",
};
const USER_TEXT: Record<PvePlan["user"], string> = {
  create: "будет создан со сгенерированным паролем",
  rotate_password: "создан Remote Hub раньше; его пароль будет заменён новым сгенерированным",
  name_taken: "уже существует и создан не Remote Hub; ничего записано не будет. Выберите другое имя",
};
const ACL_TEXT: Record<PvePlan["acl"], string> = {
  create: "будет добавлено",
  keep: "уже существует; остаётся как есть",
};
const STEP_TEXT: Record<PveSteps[keyof PveSteps], string> = {
  done: "сделано",
  kept: "уже было",
  failed: "не удалось",
  not_attempted: "не выполнялось",
  unknown: "неизвестно (запрос отправлен, ответа нет; проверьте в Proxmox)",
};
const FAILURE_TEXT: Record<string, string> = {
  plan_changed: "Proxmox изменился после того, как вы посмотрели план. Ничего не записано. Введите пароль ещё раз, чтобы увидеть текущее состояние.",
  plan_required: "План не подтверждён. Сначала просмотрите его.",
  name_taken: "Такой пользователь уже существует и создан не Remote Hub. Выберите другое имя.",
  role_differs: "Роль существует с другими правами. Подтвердите замену в плане или оставьте как есть.",
};

const portOf = (text: string): number | null => (/^\d{1,5}$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 65535 ? Number(text) : null);

export function PveOnboarding(props: PveOnboardingProps) {
  const { api } = props;
  const [mode, setMode] = useState<Mode>("restricted");
  const [name, setName] = useState("Proxmox");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("8006");
  const [adminUser, setAdminUser] = useState("root@pam");
  const [adminPassword, setAdminPassword] = useState("");
  const [aclPath, setAclPath] = useState("/");
  const [userId, setUserId] = useState<string>(PVE_PROVISION.user);
  const [authMode, setAuthMode] = useState<"ticket" | "token">("ticket");
  const [user, setUser] = useState("");
  const [secret, setSecret] = useState("");
  const [trust, setTrust] = useState<PveProfileTrust | null>(null);
  const [plan, setPlan] = useState<PvePlan | null>(null);
  const [replaceRole, setReplaceRole] = useState(false);
  const [failure, setFailure] = useState<PveFailure | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The administrator password lives in this component's state only while a review is open. It is cleared on success,
  // on cancel, after any failed attempt (the owner types it again), and it goes with the component when it unmounts.
  const forget = () => {
    setAdminPassword("");
    setSecret("");
  };

  const endpoint = () => {
    const p = portOf(port);
    if (host.trim() === "") return "Введите имя или адрес сервера Proxmox.";
    if (p === null) return "Порт — число от 1 до 65535.";
    return { host: host.trim(), port: p };
  };

  const fail = (f: PveFailure | { code: string; message: string }) => {
    forget();
    setFailure({ ok: false, code: f.code, message: f.message, fingerprint: "fingerprint" in f ? f.fingerprint : null, steps: "steps" in f ? f.steps : null, ...("profileId" in f && f.profileId !== undefined ? { profileId: f.profileId } : {}) });
  };

  const run = async (work: () => Promise<void>) => {
    setWorking(true);
    setProblem(null);
    setFailure(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      forget();
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const adminInput = (ep: { host: string; port: number }, withTrust: PveProfileTrust | null): PveAdminInput => ({ ...ep, trust: withTrust, adminUser: adminUser.trim(), adminPassword, aclPath: aclPath.trim(), userId: userId.trim() });

  const review = () =>
    run(async () => {
      const ep = endpoint();
      if (typeof ep === "string") return setProblem(ep);
      if (adminUser.trim() === "" || adminPassword === "") return setProblem("Введите пользователя и пароль администратора.");
      if (!USER_ID.test(userId.trim())) return setProblem("Новый пользователь — имя@pve: буквы, цифры, точка, дефис или подчёркивание, затем @pve.");
      const answer = await api.onboardPlan(adminInput(ep, trust));
      if (answer.ok) {
        setReplaceRole(false);
        setPlan({ role: answer.role, user: answer.user, acl: answer.acl, userId: answer.userId, rolePrivs: answer.rolePrivs, extras: answer.extras, digest: answer.digest });
      } else fail(answer);
    });

  const apply = (confirmed: PvePlan) =>
    run(async () => {
      const ep = endpoint();
      if (typeof ep === "string") return setProblem(ep);
      if (adminPassword === "") return setProblem("Введите пароль администратора ещё раз: он нужен на каждом шаге и нигде не хранится.");
      const answer = await api.onboardApply({ ...adminInput(ep, trust), name: name.trim() === "" ? "Proxmox" : name.trim(), planDigest: confirmed.digest, replaceRole });
      if (answer.ok) {
        forget();
        props.onDone(answer.profileId);
      } else {
        setPlan(null);
        setReplaceRole(false);
        fail(answer);
      }
    });

  const connectAsIs = () =>
    run(async () => {
      const ep = endpoint();
      if (typeof ep === "string") return setProblem(ep);
      if (user.trim() === "" || secret === "") return setProblem("Введите пользователя (или идентификатор токена) и пароль (или секрет токена).");
      const answer = await api.onboardConnect({ ...ep, trust, name: name.trim() === "" ? "Proxmox" : name.trim(), authMode, user: user.trim(), secret });
      if (answer.ok) {
        forget();
        props.onDone(answer.profileId);
      } else {
        fail(answer);
      }
    });

  const confirmCertificate = () => {
    if (failure?.fingerprint == null) return;
    setTrust({ mode: "pin", fingerprint: failure.fingerprint });
    setFailure(null);
    setNotice("Сертификату этого сервера теперь доверяем. Введите пароль ещё раз, чтобы продолжить.");
  };

  const certificateFailure = failure !== null && failure.fingerprint !== null && (failure.code === "tls_untrusted" || failure.code === "cert_changed");
  const blocked = plan !== null && (plan.user === "name_taken" || (plan.role === "differs" && !replaceRole));
  const locked = working || plan !== null;

  return (
    <form
      className="rh-editor rh-pve-onboarding"
      aria-label="Добавить Proxmox"
      onSubmit={(event) => {
        event.preventDefault();
        if (working) return;
        if (plan !== null) {
          if (!blocked) void apply(plan);
        } else if (mode === "restricted") void review();
        else void connectAsIs();
      }}
    >
      <fieldset aria-label="Сервер Proxmox" disabled={locked}>
        <legend>Сервер Proxmox</legend>
        <label>
          Название
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Адрес
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="pve.example.com" />
        </label>
        <label>
          Порт
          <input value={port} onChange={(e) => setPort(e.target.value)} />
        </label>
        <label className="rh-check">
          <input type="radio" name="pve-mode" checked={mode === "restricted"} onChange={() => setMode("restricted")} />
          Создать для Remote Hub пользователя с урезанными правами (рекомендуется)
        </label>
        <label className="rh-check">
          <input type="radio" name="pve-mode" checked={mode === "as_is"} onChange={() => setMode("as_is")} />
          Подключиться как есть, с моим логином или токеном API
        </label>
      </fieldset>

      {mode === "restricted" ? (
        <fieldset aria-label="Вход администратора" disabled={locked}>
          <legend>Вход администратора (только для этой настройки, нигде не хранится)</legend>
          <label>
            Пользователь-администратор
            <input value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
          </label>
          <label>
            Пароль администратора
            <input type="password" autoComplete="off" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
          </label>
          <label>
            Путь прав
            <input value={aclPath} onChange={(e) => setAclPath(e.target.value)} />
          </label>
          <label>
            Новый пользователь для Remote Hub
            <input value={userId} onChange={(e) => setUserId(e.target.value)} />
          </label>
          <p className="rh-hint">Укажите / для всего кластера или /pool/&lt;имя&gt;, чтобы ограничить нового пользователя одним пулом ресурсов. Пользователь всегда в области pve.</p>
        </fieldset>
      ) : (
        <fieldset aria-label="Вход" disabled={working}>
          <legend>Вход, сохраняемый для этого подключения</legend>
          <label>
            Способ входа
            <select value={authMode} onChange={(e) => setAuthMode(e.target.value as "ticket" | "token")}>
              <option value="ticket">Пользователь и пароль</option>
              <option value="token">Токен API</option>
            </select>
          </label>
          <label>
            {authMode === "token" ? "Идентификатор токена API (user@realm!name)" : "Пользователь (name@realm)"}
            <input value={user} onChange={(e) => setUser(e.target.value)} />
          </label>
          <label>
            {authMode === "token" ? "Секрет токена API" : "Пароль"}
            <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
          <p className="rh-hint">Сохраняется в Связке ключей macOS только для этого подключения. В Proxmox ничего не создаётся. Токен API подходит для консолей не на каждой версии Proxmox.</p>
        </fieldset>
      )}

      {plan !== null && (
        <section aria-label="Что будет создано" data-testid="pve-plan">
          <h3>Что Remote Hub создаст в Proxmox</h3>
          <ul>
            <li>
              Роль <strong>{PVE_PROVISION.role}</strong> только с правами {PVE_PROVISION.privileges.join(", ")}: {ROLE_TEXT[plan.role]}
              {plan.role === "differs" && plan.rolePrivs !== null ? ` (сейчас: ${plan.rolePrivs === "" ? "без прав" : plan.rolePrivs})` : ""}.
            </li>
            <li>
              Пользователь <strong>{plan.userId}</strong>: {USER_TEXT[plan.user]}.
            </li>
            <li>
              Право на <strong>{aclPath.trim()}</strong>, дающее этому пользователю эту роль: {ACL_TEXT[plan.acl]}.
            </li>
          </ul>
          {plan.role === "differs" && (
            <label className="rh-check">
              <input type="checkbox" checked={replaceRole} onChange={(e) => setReplaceRole(e.target.checked)} />
              Заменить права роли на четыре указанных выше. Это сузит роль и для всех, у кого она есть.
            </label>
          )}
          {plan.user === "rotate_password" && (plan.extras.acl.length > 0 || plan.extras.groups.length > 0 || plan.extras.tokens.length > 0) && (
            <div data-testid="pve-plan-extras">
              <p>У этого пользователя уже больше прав, чем выдаёт Remote Hub. Ничего из этого не убирается:</p>
              <ul>
                {plan.extras.acl.map((g) => (
                  <li key={`${g.path}|${g.role}`}>
                    Право {g.role} на {g.path}
                  </li>
                ))}
                {plan.extras.groups.map((g) => (
                  <li key={`g|${g}`}>Состоит в группе {g}</li>
                ))}
                {plan.extras.tokens.map((t) => (
                  <li key={`t|${t}`}>Токен API {t}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="rh-hint">
            Вход администратора используется на каждом шаге настройки и не хранится; после подтверждения вас больше не спросят. Новый пароль попадает только в Связку ключей macOS. Чтобы потом всё убрать, удалите пользователя и
            роль в Proxmox (<code>pveum user delete {plan.userId}</code>, <code>pveum role delete {PVE_PROVISION.role}</code>) и удалите это подключение здесь.
          </p>
        </section>
      )}

      {notice !== null && <p className="rh-hint">{notice}</p>}

      {certificateFailure && failure !== null && (
        <div className="rh-cert" data-testid="pve-onboard-cert">
          <p className="rh-error">{adviceFor(outcomeOfFailure(failure.code), null)}</p>
          <p>
            Отпечаток сертификата (SHA-256): <code>{failure.fingerprint}</code>
          </p>
          <button type="button" onClick={confirmCertificate}>
            {failure.code === "cert_changed" ? "Доверять новому сертификату" : "Доверять этому сертификату"}
          </button>
        </div>
      )}
      {failure !== null && !certificateFailure && (
        <div role="alert" className="rh-error" data-testid="pve-onboard-error">
          <p>{FAILURE_TEXT[failure.code] ?? adviceFor(outcomeOfFailure(failure.code), failure.message) ?? failure.message}</p>
          {failure.steps != null && (
            <ul data-testid="pve-onboard-steps">
              <li>Роль: {STEP_TEXT[failure.steps.role]}</li>
              <li>Пользователь: {STEP_TEXT[failure.steps.user]}</li>
              <li>Право: {STEP_TEXT[failure.steps.acl]}</li>
            </ul>
          )}
          {failure.profileId !== undefined && (
            <p>
              Настройка не завершена. Новый вход уже сохранён в подключении с пометкой «настройка не завершена». Запустите настройку ещё раз, чтобы закончить.{" "}
              <button type="button" onClick={() => props.onDone(failure.profileId as string)}>
                Оставить подключение и закрыть
              </button>
            </p>
          )}
        </div>
      )}
      {problem !== null && (
        <p role="alert" className="rh-error">
          {problem}
        </p>
      )}

      <div className="rh-editor-actions">
        <button type="submit" disabled={working || blocked}>
          {plan !== null ? "Создать и сохранить" : mode === "restricted" ? "Показать, что будет создано" : "Сохранить подключение"}
        </button>
        {plan !== null && (
          <button
            type="button"
            disabled={working}
            onClick={() => {
              setPlan(null);
              setReplaceRole(false);
            }}
          >
            Назад
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            forget();
            props.onCancel();
          }}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}
