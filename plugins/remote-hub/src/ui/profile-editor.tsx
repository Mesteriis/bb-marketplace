// Host-free profile editor (stage 3a). Sections: Connection, Authentication,
// the protocol's own fields, Source. No secret field exists here: a password is
// typed when connecting, and the credential reference is carried through as it was.
import { COLOR_DEPTHS, PRESET_LABELS, RDP_PRESETS, effectiveRdpOptions, presetOf, type RdpOptions } from "../core/rdp-options.ts";
import { AgentAccessSection } from "./agent-access-section.tsx";
import type { AgentApi } from "./agent-panel.tsx";
import { useState } from "react";
import { profileFieldsSchema, type ProfileFields } from "../core/profile.ts";
import type { PveProfileTrust } from "../core/pve-trust.ts";

/** What to do with the saved password when the profile is saved. The secret exists only in this value. */
export type SecretAction = { type: "keep" } | { type: "save"; secret: string } | { type: "remove" };

export interface ProfileEditorProps {
  /** null = a new profile. */
  initial: ProfileFields | null;
  /** Agent access for this profile (stage 4a): a separate, immediate act of the owner. Absent: no such section. */
  agentAccess?: { api: AgentApi; profileId: string | null };
  onSave: (fields: ProfileFields, secret: SecretAction) => Promise<void>;
  onCancel: () => void;
}

const BLANK: ProfileFields = {
  name: "",
  protocol: "ssh",
  group: null,
  tags: [],
  favorite: false,
  color: null,
  host: "",
  port: null,
  username: null,
  domain: null,
  authType: "agent",
  identityFile: null,
  credentialRef: null,
  rdpWidth: null,
  rdpHeight: null,
  rdpOptions: null,
  pveTrust: null,
};

/** The six experience switches and what each one is called to the owner. */
const EFFECT_SWITCHES: Array<[Exclude<keyof RdpOptions, "compression" | "colorDepth">, string]> = [
  ["wallpaper", "Обои рабочего стола"],
  ["fullWindowDrag", "Содержимое окна при перетаскивании"],
  ["menuAnimations", "Анимация меню и окон"],
  ["fontSmoothing", "Сглаживание шрифтов"],
  ["desktopComposition", "Композиция рабочего стола"],
  ["themes", "Темы оформления"],
];

const orNull = (text: string): string | null => (text.trim() === "" ? null : text.trim());

/** A whole number from text, null for empty, NaN for anything else (the schema then refuses it). */
function numberOrNull(text: string): number | null {
  if (text.trim() === "") return null;
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
}

const FIELD_LABELS: Record<string, string> = {
  name: "Название",
  host: "Адрес",
  port: "Порт",
  username: "Пользователь",
  domain: "Домен",
  identityFile: "Файл ключа",
  rdpWidth: "Ширина рабочего стола",
  authType: "Способ входа",
  color: "Цвет",
  group: "Группа",
  tags: "Метки",
};

export function ProfileEditor(props: ProfileEditorProps) {
  const start = props.initial ?? BLANK;
  const [name, setName] = useState(start.name);
  const [protocol, setProtocol] = useState<ProfileFields["protocol"]>(start.protocol);
  const [group, setGroup] = useState(start.group ?? "");
  const [tags, setTags] = useState(start.tags.join(", "));
  const [favorite, setFavorite] = useState(start.favorite);
  const [host, setHost] = useState(start.host);
  const [port, setPort] = useState(start.port === null ? "" : String(start.port));
  const [username, setUsername] = useState(start.username ?? "");
  const [domain, setDomain] = useState(start.domain ?? "");
  const [authType, setAuthType] = useState<ProfileFields["authType"]>(start.authType);
  const [identityFile, setIdentityFile] = useState(start.identityFile ?? "");
  const [width, setWidth] = useState(start.rdpWidth === null ? "" : String(start.rdpWidth));
  const [height, setHeight] = useState(start.rdpHeight === null ? "" : String(start.rdpHeight));
  // Connection quality (RDP): a profile saved without options shows, and keeps, the default.
  const [rdpOpts, setRdpOpts] = useState<RdpOptions>(effectiveRdpOptions(start.rdpOptions));
  // A password typed here lives only until Save is pressed; it is cleared at once.
  const [secret, setSecret] = useState("");
  const [removeSaved, setRemoveSaved] = useState(false);
  // Proxmox only: how the API certificate is trusted. The editor can forget a confirmed certificate; confirming one happens
  // in the guest list, where the certificate the server presented is shown.
  const [pveTrust, setPveTrust] = useState<PveProfileTrust | null>(start.pveTrust ?? null);
  const [issues, setIssues] = useState<Array<{ field: string; message: string }>>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const rdp = protocol === "rdp";
  const pve = protocol === "pve";
  const hasSaved = props.initial?.credentialRef != null;
  // The saved password is tied to its endpoint: moving the endpoint drops it (the server does that).
  const endpointMoved =
    hasSaved &&
    props.initial !== null &&
    (host.trim() !== props.initial.host ||
      (numberOrNull(port) ?? null) !== props.initial.port ||
      (orNull(username) ?? null) !== props.initial.username ||
      (orNull(domain) ?? null) !== props.initial.domain ||
      (!rdp && authType === "key" && (orNull(identityFile) ?? null) !== props.initial.identityFile));
  const effectiveAuth = rdp ? "password" : pve ? (authType === "token" ? "token" : "password") : authType;
  // What a saved secret is for: a password, or the passphrase of the key file named above.
  const secretKind: "password" | "passphrase" | null =
    effectiveAuth === "password" || effectiveAuth === "token" ? "password" : effectiveAuth === "key" && orNull(identityFile) !== null ? "passphrase" : null;
  const noun = secretKind === "passphrase" ? "парольная фраза" : effectiveAuth === "token" ? "секрет токена API" : "пароль";

  const choose = (next: ProfileFields["protocol"]) => {
    setProtocol(next);
    if (next === "rdp" || next === "pve") setAuthType("password");
  };

  const save = async () => {
    const candidate = {
      name,
      protocol,
      group: orNull(group),
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== ""),
      favorite,
      color: start.color,
      host: host.trim(),
      port: numberOrNull(port),
      username: orNull(username),
      domain: rdp ? orNull(domain) : null,
      authType: effectiveAuth,
      identityFile: !rdp && !pve && effectiveAuth === "key" ? orNull(identityFile) : null,
      credentialRef: start.credentialRef,
      rdpWidth: rdp ? numberOrNull(width) : null,
      rdpHeight: rdp ? numberOrNull(height) : null,
      rdpOptions: rdp ? rdpOpts : null,
      ...(pve ? { pveTrust } : {}),
    };
    const parsed = profileFieldsSchema.safeParse(candidate);
    if (!parsed.success) {
      setIssues(
        parsed.error.issues.map((issue) => {
          const key = String(issue.path[0] ?? "name");
          return { field: key, message: (FIELD_LABELS[key] ?? key) + ": " + issue.message };
        }),
      );
      return;
    }
    setIssues([]);
    setSaveError(null);
    setSaving(true);
    const action: SecretAction = removeSaved ? { type: "remove" } : secret !== "" ? { type: "save", secret } : { type: "keep" };
    setSecret("");
    try {
      await props.onSave(parsed.data, action);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="rh-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset aria-label="Подключение">
        <legend>Подключение</legend>
        <label>
          Название
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Протокол
          <select value={protocol} onChange={(e) => choose(e.target.value as ProfileFields["protocol"])}>
            <option value="ssh">SSH</option>
            <option value="rdp">RDP</option>
            <option value="pve">Proxmox VE</option>
          </select>
        </label>
        <label>
          Адрес
          <input value={host} onChange={(e) => setHost(e.target.value)} />
        </label>
        <label>
          Порт
          <input value={port} onChange={(e) => setPort(e.target.value)} placeholder={rdp ? "3389" : pve ? "8006" : "22"} />
        </label>
        <label>
          {pve ? (effectiveAuth === "token" ? "Идентификатор токена API (user@realm!name)" : "Пользователь (name@realm)") : "Пользователь"}
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        {rdp && (
          <label>
            Домен
            <input value={domain} onChange={(e) => setDomain(e.target.value)} />
          </label>
        )}
        <label>
          Группа
          <input value={group} onChange={(e) => setGroup(e.target.value)} />
        </label>
        <label>
          Метки
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="через запятую" />
        </label>
        <label className="rh-check">
          <input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} />
          Избранное
        </label>
      </fieldset>

      <fieldset aria-label="Вход">
        <legend>Вход</legend>
        <label>
          Способ входа
          <select value={effectiveAuth} onChange={(e) => setAuthType(e.target.value as ProfileFields["authType"])}>
            {rdp ? (
              <option value="password">Пароль</option>
            ) : pve ? (
              <>
                <option value="password">Пользователь и пароль (билет)</option>
                <option value="token">Токен API</option>
              </>
            ) : (
              <>
                <option value="agent">Агент SSH / ключи по умолчанию</option>
                <option value="key">Файл ключа</option>
                <option value="password">Пароль</option>
              </>
            )}
          </select>
        </label>
        {!rdp && effectiveAuth === "key" && (
          <label>
            Файл ключа
            <input value={identityFile} onChange={(e) => setIdentityFile(e.target.value)} placeholder="/Users/you/.ssh/id_ed25519" />
          </label>
        )}
        {secretKind !== null && (
          <>
            {hasSaved ? (
              <>
                <p className="rh-hint">Для этого подключения в Связке ключей сохранён секрет: {noun}.</p>
                <label>
                  Заменить сохранённый секрет ({noun})
                  <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} disabled={removeSaved} />
                </label>
                <label className="rh-check">
                  <input type="checkbox" checked={removeSaved} onChange={(e) => setRemoveSaved(e.target.checked)} />
                  Удалить сохранённый секрет ({noun})
                </label>
                {endpointMoved && <p className="rh-error">Меняются адрес, порт, пользователь, домен или файл ключа: сохранённый секрет ({noun}) будет забыт.</p>}
              </>
            ) : (
              <label>
                {secretKind === "passphrase" ? "Парольная фраза" : "Пароль"} для сохранения в Связке ключей
                <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
              </label>
            )}
          </>
        )}
        <p className="rh-hint">
          {secretKind !== null
            ? hasSaved
              ? `При подключении используется сохранённый секрет (${noun}); вводить ничего не нужно.`
              : `Оставьте пустым, чтобы вводить при каждом подключении, или введите, чтобы хранить в Связке ключей.`
            : effectiveAuth === "key"
              ? "Укажите путь к файлу ключа, чтобы хранить его парольную фразу в Связке ключей; иначе OpenSSH спросит её в терминале."
              : "OpenSSH использует свой агент и ключи по умолчанию."}
        </p>
      </fieldset>

      {rdp && (
        <fieldset aria-label="RDP">
          <legend>RDP</legend>
          <label>
            Ширина рабочего стола
            <input value={width} onChange={(e) => setWidth(e.target.value)} placeholder="1280" />
          </label>
          <label>
            Высота рабочего стола
            <input value={height} onChange={(e) => setHeight(e.target.value)} placeholder="800" />
          </label>
          <label>
            Качество соединения
            <select
              value={presetOf(rdpOpts)}
              onChange={(e) => {
                const next = e.target.value;
                if (next === "slow" || next === "balanced" || next === "quality") setRdpOpts(RDP_PRESETS[next]);
              }}
            >
              {(["slow", "balanced", "quality"] as const).map((name) => (
                <option key={name} value={name}>
                  {PRESET_LABELS[name]}
                </option>
              ))}
              {presetOf(rdpOpts) === "custom" && <option value="custom">{PRESET_LABELS.custom}</option>}
            </select>
          </label>
          <p className="rh-hint">Меньше данных на медленной связи, больше деталей на быстрой. Сервер может не учитывать переключатели эффектов.</p>
          <details>
            <summary>Дополнительно</summary>
            <label className="rh-check">
              <input type="checkbox" checked={rdpOpts.compression} onChange={(e) => setRdpOpts({ ...rdpOpts, compression: e.target.checked })} />
              Сжимать поток обновлений
            </label>
            <label>
              Глубина цвета
              <select value={rdpOpts.colorDepth} onChange={(e) => setRdpOpts({ ...rdpOpts, colorDepth: Number(e.target.value) as RdpOptions["colorDepth"] })}>
                {COLOR_DEPTHS.map((d) => (
                  <option key={d} value={d}>
                    {d} бит на пиксель
                  </option>
                ))}
              </select>
            </label>
            {EFFECT_SWITCHES.map(([key, label]) => (
              <label key={key} className="rh-check">
                <input type="checkbox" checked={rdpOpts[key]} onChange={(e) => setRdpOpts({ ...rdpOpts, [key]: e.target.checked })} />
                {label}
              </label>
            ))}
          </details>
        </fieldset>
      )}

      {pve && (
        <fieldset aria-label="Сертификат">
          <legend>Сертификат</legend>
          <p className="rh-hint" data-testid="pve-trust-text">
            {pveTrust === null || pveTrust.mode === "system"
              ? "Сертификату сервера должен доверять этот Mac. Если это не так, в списке гостей появится его отпечаток с просьбой подтвердить."
              : pveTrust.mode === "pin"
                ? "Доверие только подтверждённому вами сертификату: " + pveTrust.fingerprint
                : "Доверие только указанному вами центру сертификации."}
          </p>
          {pveTrust !== null && pveTrust.mode !== "system" && (
            <button type="button" onClick={() => setPveTrust(null)}>
              Забыть и доверять сертификатам этого Mac
            </button>
          )}
        </fieldset>
      )}

      {props.agentAccess !== undefined && <AgentAccessSection api={props.agentAccess.api} profileId={props.agentAccess.profileId} />}

      <fieldset aria-label="Источник">
        <legend>Источник</legend>
        <p className="rh-hint">{props.initial === null ? "Создано вручную." : "Создано вручную в Remote Hub."}</p>
      </fieldset>

      {issues.map((issue, i) => (
        <p key={i} role="alert" className="rh-error">
          {issue.message}
        </p>
      ))}
      {saveError !== null && <p className="rh-error">{saveError}</p>}
      <div className="rh-editor-actions">
        <button type="submit" disabled={saving}>
          Сохранить
        </button>
        <button type="button" onClick={props.onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}
