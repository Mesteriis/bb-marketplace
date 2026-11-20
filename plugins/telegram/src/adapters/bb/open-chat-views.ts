import type { TdObject, connectTdJson } from "./tdjson.ts";

type Request = ReturnType<typeof connectTdJson>["request"];
type Chat = { showOnline: boolean; views: Map<string, number>; online: number | null };

export function createOpenChatViews(request: Request, ready: () => boolean, emit?: (chatId: string, online: number | null) => void) {
  const chats = new Map<number, Chat>();
  let pending = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(work);
    pending = result.then(() => {}, () => {});
    return result;
  }

  async function release(chat_id: number) {
    chats.delete(chat_id);
    if (!disposed && ready()) await request({ "@type": "closeChat", chat_id }).catch(() => undefined);
  }

  function schedule() {
    clearTimeout(timer);
    if (disposed) return;
    let first = Infinity;
    for (const chat of chats.values()) for (const expiry of chat.views.values()) first = Math.min(first, expiry);
    if (!Number.isFinite(first)) return;
    timer = setTimeout(() => {
      void serial(async () => {
        const now = Date.now();
        for (const [id, chat] of chats) {
          for (const [view, expiry] of chat.views) if (expiry <= now) chat.views.delete(view);
          if (!chat.views.size) await release(id);
        }
        schedule();
      });
    }, Math.max(1, first - Date.now()));
    timer.unref?.();
  }

  return {
    set(chatId: string, view: string, open: boolean): Promise<number | null> {
      return serial(async () => {
        const chat_id = Number(chatId);
        if (disposed || !ready() || !Number.isSafeInteger(chat_id) || chat_id === 0) return null;
        let chatView = chats.get(chat_id);
        if (!open) {
          if (chatView?.views.delete(view) && !chatView.views.size) await release(chat_id);
          schedule();
          return null;
        }
        if (!chatView) {
          if (chats.size >= 32) return null;
          const chat = await request({ "@type": "getChat", chat_id });
          const type = chat.type as TdObject | null | undefined;
          const kind = type?.["@type"];
          const showOnline = kind === "chatTypeBasicGroup" || (kind === "chatTypeSupergroup" && type?.is_channel !== true);
          if (chat["@type"] !== "chat" || chat.id !== chat_id || disposed || !ready()
            || (!showOnline && kind !== "chatTypePrivate" && kind !== "chatTypeSupergroup")) return null;
          chatView = { showOnline, views: new Map(), online: null };
          chats.set(chat_id, chatView);
          try {
            const response = await request({ "@type": "openChat", chat_id });
            if (response["@type"] !== "ok" || disposed) {
              chats.delete(chat_id);
              return null;
            }
          } catch (error) {
            chats.delete(chat_id);
            throw error;
          }
        } else if (!chatView.views.has(view) && chatView.views.size >= 32) return chatView.online;
        chatView.views.set(view, Date.now() + 45_000);
        schedule();
        return chatView.online;
      });
    },
    update(event: TdObject) {
      const chat_id = event.chat_id;
      const count = event.online_member_count;
      if (disposed || !ready() || typeof chat_id !== "number" || typeof count !== "number"
        || !Number.isInteger(count) || count < 0 || count > 2147483647) return;
      const chatView = chats.get(chat_id);
      if (!chatView?.showOnline) return;
      const online = count || null;
      if (online === chatView.online) return;
      chatView.online = online;
      emit?.(String(chat_id), online);
    },
    clear() {
      disposed = true;
      clearTimeout(timer);
      chats.clear();
    },
  };
}
