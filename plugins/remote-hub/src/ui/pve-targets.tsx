// Proxmox guests of the saved connections: one section per connection with its own outcome (so a connection that fails
// never hides the others), a search over name, VMID, node and kind, and a card per guest. There are no power buttons:
// Remote Hub never starts or stops a guest. "Open console" is disabled with its reason; a guest links to an SSH or RDP
// profile the owner chooses, never to an address guessed from Proxmox.
import { useCallback, useEffect, useState } from "react";
import type { Profile } from "../core/profile.ts";
import { searchGuests, type PveConnectionView, type PveGuestView, type PveOutcome } from "../core/pve-targets.ts";
import type { PveApi, PveConsoleRequest } from "./pve-api.ts";

export interface PveTargetsProps {
  api: PveApi;
  /** The Proxmox connections to show; null = all of them. */
  profileIds: string[] | null;
  /** Saved SSH and RDP profiles a guest can be linked to. */
  linkable: Profile[];
  onConnectProfile: (profileId: string) => void;
  /** "Allow access" for a connection whose saved password macOS has not let this helper build read; without it there is no button. */
  onAllowAccess?: (credentialRef: string) => Promise<unknown>;
  /** Opens a console of a guest or a node shell. Without it the console buttons stay off. */
  onOpenConsole?: (open: { profileId: string; connectionName: string; request: PveConsoleRequest; title: string }) => void;
  onClose: () => void;
}

const OUTCOME_LABEL: Record<PveOutcome, string> = {
  ok: "подключено",
  empty: "гостей не видно",
  no_permission: "нет прав",
  login_failed: "вход отклонён",
  unreachable: "недоступен",
  tls_untrusted: "сертификат не доверенный",
  cert_changed: "сертификат изменился",
  tfa_required: "нужен второй фактор",
  no_credential: "нет сохранённого пароля или токена",
  keychain_locked: "Связка ключей заблокирована",
  keychain_needs_approval: "нужно разрешение",
  error: "ошибка",
};

function age(seconds: number): string {
  if (seconds < 90) return `${seconds} с`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} мин`;
  return `${Math.round(seconds / 3600)} ч`;
}

/** Shown in place of a console button that cannot work because the page was built without console support. */
export const CONSOLE_OFF_REASON = "Консоли в этом виде недоступны.";

function GuestCard(props: { guest: PveGuestView; linkable: Profile[]; onLink: (vmid: number, linkProfileId: string | null) => void; onConnectProfile: (id: string) => void; onOpenConsole?: (() => void) | undefined }) {
  const { guest, linkable } = props;
  const linked = guest.linkedProfileId === null ? null : (linkable.find((p) => p.id === guest.linkedProfileId) ?? null);
  const reason = guest.console.available ? (props.onOpenConsole === undefined ? CONSOLE_OFF_REASON : null) : (guest.console.reason ?? "недоступна");
  const label = guest.kind === "qemu" ? "Открыть графику" : "Открыть консоль";
  return (
    <li className="rh-guest" aria-label={guest.name || String(guest.vmid)} data-testid="pve-guest">
      <span className="rh-guest-title">
        <strong>{guest.name || "(без имени)"}</strong> <span className="rh-badge">{guest.kind === "qemu" ? "VM" : "LXC"}</span> <span className="rh-guest-id">#{guest.vmid}</span>
      </span>
      <span className="rh-status" data-testid="pve-guest-state">
        {guest.template ? "шаблон" : guest.status} · узел {guest.node}
      </span>
      <div className="rh-guest-actions">
        <button type="button" disabled={reason !== null} aria-label={"Открыть консоль: " + (guest.name || guest.vmid)} title={reason ?? undefined} onClick={() => props.onOpenConsole?.()}>
          {label}
        </button>
        {reason !== null && (
          <span className="rh-hint" data-testid="pve-console-reason">
            {reason}
          </span>
        )}
        <label>
          Подключение SSH или RDP
          <select
            aria-label={"Связанное подключение: " + (guest.name || guest.vmid)}
            value={guest.linkedProfileId ?? ""}
            onChange={(e) => props.onLink(guest.vmid, e.target.value === "" ? null : e.target.value)}
          >
            <option value="">нет</option>
            {linkable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.protocol.toUpperCase()})
              </option>
            ))}
          </select>
        </label>
        {linked !== null && (
          <button type="button" aria-label={"Подключиться к " + (guest.name || guest.vmid) + " через " + linked.name} onClick={() => props.onConnectProfile(linked.id)}>
            Подключиться через {linked.name}
          </button>
        )}
      </div>
    </li>
  );
}

export function PveTargets(props: PveTargetsProps) {
  const { api, profileIds } = props;
  const [connections, setConnections] = useState<PveConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const idsKey = profileIds === null ? "" : profileIds.join(",");

  const load = useCallback(
    async (refresh: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const answer = await api.targets({ ...(idsKey === "" ? {} : { profileIds: idsKey.split(",") }), refresh });
        setConnections(answer.connections);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [api, idsKey],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const pin = async (profileId: string, fingerprint: string) => {
    try {
      await api.pinTrust(profileId, fingerprint);
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const allow = async (ref: string) => {
    try {
      await props.onAllowAccess?.(ref);
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const link = async (profileId: string, vmid: number, linkProfileId: string | null) => {
    try {
      await api.linkGuest(profileId, vmid, linkProfileId);
      await load(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="rh-pve" aria-label="Гости Proxmox">
      <div className="rh-pve-tools">
        <input aria-label="Поиск гостей" placeholder="Поиск по имени, номеру, узлу или типу" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" disabled={busy} onClick={() => void load(true)}>
          Обновить
        </button>
        <button type="button" onClick={props.onClose}>
          Закрыть
        </button>
      </div>
      {error !== null && <p className="rh-error">{error}</p>}
      {connections === null && error === null && <p className="rh-hint">Читаю Proxmox…</p>}
      {connections !== null && connections.length === 0 && <p className="rh-hint">Подключений Proxmox пока нет. Добавьте через «+» → Proxmox VE.</p>}
      {(connections ?? []).map((c) => {
        const guests = searchGuests(c.guests, query);
        return (
          <section key={c.profileId} className="rh-pve-connection" aria-label={c.profileName} data-testid="pve-connection">
            <h3>
              {c.profileName} <span className="rh-badge" data-testid="pve-outcome">{OUTCOME_LABEL[c.outcome]}</span>
              {c.version !== null && <span className="rh-hint"> Proxmox VE {c.version}</span>}
            </h3>
            {c.stale !== null && (
              <p className="rh-hint" data-testid="pve-stale">
                Показан последний список, прочитанный {age(c.stale.ageSeconds)} назад; сейчас сервер недоступен.
              </p>
            )}
            {c.message !== null && <p className="rh-error">{c.message}</p>}
            {c.outcome === "keychain_needs_approval" && c.credentialRef !== null && props.onAllowAccess !== undefined && (
              <p>
                <button type="button" onClick={() => void allow(c.credentialRef as string)} title="macOS спросит один раз; выберите «Всегда разрешать». Пока открыт его диалог, остальные сессии на паузе.">
                  Разрешить доступ
                </button>
              </p>
            )}
            {c.fingerprint !== null && (c.outcome === "tls_untrusted" || c.outcome === "cert_changed") && (
              <div className="rh-cert" data-testid="pve-cert">
                <p>
                  Отпечаток сертификата (SHA-256): <code>{c.fingerprint}</code>
                </p>
                <button type="button" onClick={() => void pin(c.profileId, c.fingerprint as string)}>
                  {c.outcome === "cert_changed" ? "Доверять новому сертификату" : "Доверять этому сертификату"}
                </button>
              </div>
            )}
            {c.outcome === "empty" && <p className="rh-hint">Учётная запись не видит ни виртуальных машин, ни контейнеров.</p>}
            {guests.length === 0 && c.guests.length > 0 && <p className="rh-hint">Ни один гость не подходит.</p>}
            {props.onOpenConsole !== undefined && c.nodes.length > 0 && (
              <div className="rh-pve-nodes" aria-label={"Узлы: " + c.profileName}>
                {c.nodes.map((n) => (
                  <button
                    key={n.node}
                    type="button"
                    disabled={n.status !== "online"}
                    title={n.status === "online" ? undefined : "Узел: " + n.status}
                    aria-label={"Открыть оболочку узла " + n.node}
                    onClick={() => props.onOpenConsole?.({ profileId: c.profileId, connectionName: c.profileName, request: { console: "node", node: n.node }, title: n.node })}
                  >
                    Оболочка узла: {n.node}
                  </button>
                ))}
              </div>
            )}
            <ul>
              {guests.map((g) => (
                <GuestCard
                  key={g.key}
                  guest={g}
                  linkable={props.linkable}
                  onLink={(vmid, to) => void link(c.profileId, vmid, to)}
                  onConnectProfile={props.onConnectProfile}
                  onOpenConsole={
                    props.onOpenConsole === undefined
                      ? undefined
                      : () => props.onOpenConsole?.({ profileId: c.profileId, connectionName: c.profileName, request: { console: g.kind, vmid: g.vmid }, title: g.name })
                  }
                />
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
