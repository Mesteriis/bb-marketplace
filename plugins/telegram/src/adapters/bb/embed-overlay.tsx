import { useEmbedHistory } from "./embed-history.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import { schemas, messageNotificationChannel, messageNotificationDelivery,
  type ResumedConversation, type ConversationLocation } from "../../core/contract.ts";
import type { rpcContract } from "../../../server.ts";
import type { z } from "zod";
import { TelegramPortals, type EmbedPanel } from "./embed-portals.tsx";
import { EmbedConversation, type BoundCall } from "./embed-conversation.tsx";
import { omitUndefinedRpcFields } from "./rpc-wire.ts";

type Method = "embedChatChoices" | "forumTopics" | "bindEmbedChat" | "resolveEmbedChat" | "embedChatAction";
type SessionCall = <K extends Method>(method: K, input: z.input<(typeof schemas)[K]["input"]>) => Promise<z.output<(typeof schemas)[K]["output"]>>;

export function TelegramEmbedOverlay() {
  return <TelegramPortals renderPanel={panel => <Tile panel={panel} />} />;
}

function Tile({ panel }: { panel: EmbedPanel }) {
  const rpc = useRpc<typeof rpcContract>();
  const [connection, setConnection] = useState<string | null | false>();
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    async function check() {
      const status = await rpc.call("status").catch(() => null);
      if (!alive) return;
      if (status) {
        failures = 0;
        setConnection(status.state === "ready" ? status.connectionId ?? null : null);
      } else if (++failures >= 3) {
        setConnection(false);
        return;
      }
      timer = setTimeout(() => void check(), 2500);
    }
    void check();
    return () => { alive = false; clearTimeout(timer); };
  }, [rpc]);
  useEffect(() => { if (connection === null) panel.status(panel.resourceRef ? "denied" : "choosing"); else if (connection === false) panel.status("lost"); }, [connection, panel]);
  const call = useMemo<SessionCall>(() => async (method, input) => {
    if (!connection) throw new Error("Telegram connection unavailable");
    const value = await rpc.call("sessionRpc", { connectionId: connection, method, payload: omitUndefinedRpcFields(input) });
    return schemas[method].output.parse(value) as never;
  }, [connection, rpc]);
  return <>{panel.closing && <div role="dialog" aria-label="Закрыть вид Telegram">
    <p>Закрыть этот вид и его локальный черновик?</p>
    <button onClick={() => panel.keep()}>Оставить</button><button onClick={() => panel.hide()}>Скрыть</button><button onClick={() => panel.status("ended")}>Закрыть вид</button></div>}
    {connection === undefined ? <p>Проверяем подключение Telegram…</p> : connection === false ? <p>Связь с Telegram потеряна.</p> : !connection
      ? <p>Для выбора чата войдите в Telegram на странице плагина.</p> : panel.resourceRef
      ? <Resolved key={connection + panel.resourceRef} connection={connection} resourceRef={panel.resourceRef} call={call} panel={panel} />
      : <Picker key={connection} call={call} panel={panel} />}</>;
}

function Picker({ call, panel }: { call: SessionCall; panel: EmbedPanel }) {
  const [query, setQuery] = useState("");
  const [forum, setForum] = useState<string>();
  const [items, setItems] = useState<{ name: string; location: ConversationLocation; forum?: boolean }[]>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    setItems(undefined); setError(""); panel.status("choosing");
    const q = query.trim();
    async function load() {
      if (forum) {
        const topics = await call("forumTopics", { id: forum, query: q });
        if (topics === null) throw new Error("Unavailable topics");
        return topics.map(topic => ({ name: topic.name, location: { id: forum, list: "main" as const, topicId: topic.id } }));
      }
      const chats = await call("embedChatChoices", { query: q });
      return chats.map(chat => ({ name: chat.name, forum: chat.forum, location: { id: chat.id, list: "main" as const } }));
    }
    void load().then(rows => { if (current) { setItems(rows); } },
      () => { if (current) { setError(forum ? "Темы недоступны. Вернитесь к списку и выберите другой чат." : "Не удалось загрузить список чатов. Повторите поиск."); } });
    return () => { current = false; };
  }, [call, forum, query, panel]);
  async function select(location: ConversationLocation) {
    setPending(true);
    try { const ref = await call("bindEmbedChat", location); if (alive.current) panel.select(ref); }
    catch { if (alive.current) { setPending(false); setError(location.topicId ? "Эта тема недоступна. Выберите другую тему или чат." : "Этот чат недоступен. Выберите другой чат."); } }
  }
  return <section aria-label="Выбор чата Telegram"><label>{forum ? "Найти тему" : "Найти чат"}
    <input value={query} maxLength={128} disabled={pending} onChange={e => setQuery(e.target.value)} /></label>
    {error ? <p role="alert">{error}</p> : !items ? <p>Загрузка…</p> : !items.length && <p>Ничего не найдено.</p>}
    <ul>{items?.map(item => <li key={item.location.topicId ?? item.location.id}><button disabled={pending}
      onClick={() => void select(item.location)}>{item.name}</button>{item.forum && <button disabled={pending} onClick={() => { setQuery(""); setForum(item.location.id); }}>Темы · {item.name}</button>}</li>)}</ul>
    {forum && <button disabled={pending} onClick={() => { setForum(undefined); setQuery(""); }}>Назад к чатам</button>}
    <button onClick={() => panel.status("cancelled")}>Отменить выбор</button></section>;
}

function Resolved({ call, resourceRef, connection, panel }: { call: SessionCall; resourceRef: string; connection: string; panel: EmbedPanel }) {
  const [target, setTarget] = useState<ResumedConversation>();
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    void call("resolveEmbedChat", { resourceRef }).then(value => { if (alive) { setTarget(value); panel.status("ready"); } },
      () => { if (alive) { setFailed(true); panel.status("denied"); } });
    return () => { alive = false; };
  }, [call, resourceRef, panel]);
  useRealtime(messageNotificationChannel, raw => {
    const delivery = messageNotificationDelivery.safeParse(raw).data;
    if (!delivery || delivery.connectionId !== connection || "removed" in delivery.event) return;
    const event = "refreshed" in delivery.event ? delivery.event.refreshed : delivery.event;
    if (event.chatId === target?.chat.id && (!target.topic || target.topic.id === event.topicId)) setRevision(n => n + 1);
  });
  const bound = useCallback<BoundCall>(async (method, payload) => {
    const value = await call("embedChatAction", { resourceRef, method, payload });
    return schemas[method].output.parse(value) as never;
  }, [call, resourceRef]);
  const updates = useEmbedHistory(connection, target, bound);
  return failed ? <p role="alert">Чат недоступен для текущего аккаунта.</p> : !target ? <p>Открываем чат…</p>
    : <EmbedConversation target={target} call={bound} revision={revision} updates={updates} draftStorage={panel.drafts(resourceRef)} />;
}
