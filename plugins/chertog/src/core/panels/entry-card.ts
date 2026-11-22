import { z } from "zod";
import { panelRefSchema, type PanelRef } from "./ref.ts";

const id = z.string().min(1).refine(value =>
  panelRefSchema.safeParse({ provider: "entry", params: { id: value } }).success && !/[\uD800-\uDFFF]/u.test(value)
);
const empty = z.strictObject({});
const thread = z.strictObject({ threadId: id });
const path = id.refine(value => {
  try {
    const decoded = decodeURIComponent(value);
    return !/[\\:\u0000-\u001f\u007f]/.test(decoded) &&
      decoded.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
  } catch {
    return false;
  }
});
const file = z.strictObject({ kind: z.literal("workspace"), environmentId: id, path });
const routeId = id.refine(value => value !== "." && value !== "..");
const review = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("uncommitted"), threadId: routeId }),
  z.strictObject({ kind: z.literal("commit"), threadId: routeId, sha: z.string().regex(/^[0-9a-f]{40}$/i) }),
]);

export function fileTarget(params: PanelRef["params"]) {
  const parsed = file.parse(params);
  return { ...parsed, path: decodeURIComponent(parsed.path) };
}

function section(title: string, purpose: string, plugin: string, route: string) {
  return { title, purpose, plugin, route, paramsSchema: empty };
}

export const entryCards = {
  telegram: section("Telegram", "Открыть список чатов и выбрать переписку.", "makosh-telegram", "telegram"),
  zoom: section("Zoom", "Открыть календарь и выбрать встречу.", "makosh-zoom", "zoom"),
  "remote-ssh": section("Remote Hub · SSH", "Выбрать SSH-профиль или существующую сессию.", "makosh-remote-hub", "ssh"),
  "remote-rdp": section("Remote Hub · RDP", "Выбрать удалённый рабочий стол.", "makosh-remote-hub", "ssh"),
  "remote-vnc": section("Remote Hub · VNC", "Выбрать консоль виртуальной машины.", "makosh-remote-hub", "ssh"),
  terminals: section("Terminals", "Перейти к списку терминалов.", "terminals", "terminals"),
  "markdown-editor": { title: "Markdown Editor", purpose: "Открыть файл и выбрать редактор Markdown.", plugin: "markdown-editor", paramsSchema: file },
  "bb-editor": { title: "BB редактор", purpose: "Открыть файл в BB или во внешнем редакторе.", plugin: null, paramsSchema: file },
  "bb-terminal": { title: "BB терминал", purpose: "Открыть уже существующий терминал.", plugin: null, paramsSchema: z.strictObject({ terminalId: id }) },
  "diff-review": { title: "Diff Review", purpose: "Открыть выбранные изменения на странице ревью.", plugin: "diff-review", paramsSchema: review },
  "bb-desktop-tab": { title: "Вкладка Desktop", purpose: "Выбрать экземпляр Desktop и открытую вкладку треда.", plugin: null, paramsSchema: z.strictObject({ hostId: id, threadId: id }) },
  "app-preview": { title: "App Preview", purpose: "Перейти к треду и открыть предпросмотр в BB.", plugin: "app-preview", paramsSchema: z.union([thread, thread.extend({ tabId: id })]) },
} as const;

export type CardType = keyof typeof entryCards;

export function entryRoute(ref: PanelRef): string | null {
  if (!Object.hasOwn(entryCards, ref.provider)) return null;
  const card = entryCards[ref.provider as CardType];
  card.paramsSchema.parse(ref.params);
  if ("route" in card) return "/plugins/" + encodeURIComponent(card.plugin) + "/" + encodeURIComponent(card.route);
  if (ref.provider !== "diff-review") return null;
  const { threadId, ...target } = review.parse(ref.params);
  const encoded = encodeURIComponent(JSON.stringify(target));
  return "/plugins/diff-review/reviews/" + encodeURIComponent(threadId) + "/" + encodeURIComponent(encoded);
}
