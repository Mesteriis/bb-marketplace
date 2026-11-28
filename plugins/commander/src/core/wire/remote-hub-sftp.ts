// Ручное zod-зеркало контракта Remote Hub для других плагинов (remote-hub@e1b0d502):
// plugins/remote-hub/src/core/sftp-contract.ts. Плагины не импортируют файлы друг друга,
// поэтому схемы переписаны здесь. Ничего, кроме zod и самого себя, не импортирует.
//
// Секретов в контракте нет: ни одна схема не имеет поля для ключа, пути к ключу,
// ссылки на учётные данные или имени элемента Keychain (все объекты `.strict()`).
import { z } from "zod";

export const REMOTE_HUB_SFTP_CONTRACT = "remote-hub@e1b0d502";

export const SFTP_LIMITS = {
  /** Наибольший объём байт одного чтения или одной записи. */
  chunkBytes: 4 * 1024 * 1024,
  /** Открытых каналов на плагин. */
  channelsPerPlugin: 4,
  /** Записей в одной странице листинга. */
  listPage: 1000,
  /** Записей каталога, которые обходит листинг; дальше он заканчивается `limit_exceeded`. */
  listTotal: 10_000,
  pathBytes: 4096,
  reasonChars: 200,
} as const;

export const SFTP_LEVELS = ["read", "write"] as const;
export type SftpLevel = (typeof SFTP_LEVELS)[number];

/** `write` включает `read`. */
export function levelAllows(granted: SftpLevel, needed: SftpLevel): boolean {
  return SFTP_LEVELS.indexOf(granted) >= SFTP_LEVELS.indexOf(needed);
}

/**
 * How many bytes canonical base64 text decodes to, or null when it is not canonical base64 (standard alphabet, length a
 * multiple of four, at most two `=` and only at the end). A 4 MiB chunk is 5.6 million characters. A per-character check
 * in JavaScript (a loop or a regular expression) costs about 40 ms per chunk on random data, 29 s of 48 s CPU on a
 * 1 GiB read (S18). Instead the text is decoded natively. The decoder skips what is not base64 and also accepts the
 * URL alphabet, so a decoded length equal to the expected one, with no `-` and no `_` in the text, proves that every
 * character before the padding was a standard one. Anything else takes the exact character loop. Trailing bits of
 * the last character are not checked, as before.
 */
export function base64Bytes(text: string): number | null {
  const n = text.length;
  if (n % 4 !== 0) return null;
  const decoded = Buffer.from(text, "base64");
  const pad = n > 0 && text.charCodeAt(n - 1) === 61 ? (text.charCodeAt(n - 2) === 61 ? 2 : 1) : 0;
  if (decoded.length === (n / 4) * 3 - pad && !text.includes("-") && !text.includes("_")) return decoded.length;
  return base64BytesScan(text);
}

function base64BytesScan(text: string): number | null {
  const n = text.length;
  let pad = 0;
  if (n > 0 && text.charCodeAt(n - 1) === 61) pad = text.charCodeAt(n - 2) === 61 ? 2 : 1;
  for (let i = 0; i < n - pad; i++) {
    const c = text.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;
    if (!ok) return null;
  }
  return (n / 4) * 3 - pad;
}

/** Canonical base64 of at most `maxBytes` DECODED bytes (the padding is counted, so one byte over is refused). */
const base64Schema = (maxBytes: number) =>
  z
    .string()
    .max(Math.ceil(maxBytes / 3) * 4)
    .refine((s) => {
      const bytes = base64Bytes(s);
      return bytes !== null && bytes <= maxBytes;
    }, "not canonical base64, or more bytes than allowed");

/**
 * Путь или имя на сервере. `text`, если это валидный UTF-8; `bytes` (base64 сырых байтов), если нет,
 * чтобы имя, которое держит сервер, никогда не менялось молча.
 */
export const sftpPathSchema = z.union([
  z.object({ text: z.string().min(1).max(SFTP_LIMITS.pathBytes).refine((s) => !s.includes("\u0000"), "a path has no NUL") }).strict(),
  z.object({ bytes: base64Schema(SFTP_LIMITS.pathBytes).refine((value) => value.length >= 4, "at least one byte") }).strict(),
]);
export type SftpPath = z.infer<typeof sftpPathSchema>;

const UINT64_MAX = 18446744073709551615n;
/** Беззнаковое 64-битное число десятичной строкой: размеры и смещения сохраняют точность больше 2^53. */
export const uint64Schema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((s) => BigInt(s) <= UINT64_MAX, "larger than an unsigned 64-bit number");

export const sftpAttrsSchema = z
  .object({
    type: z.enum(["file", "dir", "symlink", "other"]),
    size: uint64Schema,
    /** Секунды от эпохи, как их отдал сервер (SFTP v3 — целые секунды); null, если не отдал. */
    mtime: z.number().int().min(0).nullable(),
    /** Биты режима POSIX с типом файла, как их отдал сервер; null, если не отдал. */
    mode: z.number().int().min(0).max(0xffffffff).nullable(),
    /** Куда указывает симлинк, как хранится (не разрешается); null для остального или если не прочитано. */
    linkTarget: sftpPathSchema.nullable(),
  })
  .strict();
export type SftpAttrs = z.infer<typeof sftpAttrsSchema>;

const channelId = z.string().uuid();
const profileId = z.string().uuid();
const generation = z.string().regex(/^[0-9a-f]{32}$/);

const onChannel = <O extends string, T extends z.ZodRawShape>(op: O, shape: T) =>
  z.object({ channelId, op: z.literal(op), ...shape }).strict();

const writeSchema = onChannel("write", {
  path: sftpPathSchema,
  offset: uint64Schema,
  data: base64Schema(SFTP_LIMITS.chunkBytes),
  /**
   * Как открывается файл для этого куска. `exclusive`: его ещё не должно быть (первый кусок нового файла;
   * второй писатель получит `exists`). `truncate`: создан или опустошён (первый кусок при замене).
   * `existing`: должен существовать; кусок пишется по `offset` (каждый следующий кусок). Первые два
   * начинаются с offset 0.
   */
  create: z.enum(["exclusive", "truncate", "existing"]),
}).refine((w) => w.create === "existing" || w.offset === "0", "exclusive and truncate start at offset 0");

export const sftpOpInputSchema = z.union([
  z.discriminatedUnion("op", [
    onChannel("list", {
      path: sftpPathSchema,
      /** Opaque: what the previous page returned as `nextCursor`. */
      cursor: z.string().min(1).max(1024).optional(),
      limit: z.number().int().min(1).max(SFTP_LIMITS.listPage).optional(),
    }),
    /** true: куда указывает симлинк; false: сам линк. */
    onChannel("stat", { path: sftpPathSchema, follow: z.boolean() }),
    onChannel("realpath", { path: sftpPathSchema }),
    onChannel("read", { path: sftpPathSchema, offset: uint64Schema, length: z.number().int().min(1).max(SFTP_LIMITS.chunkBytes) }),
    onChannel("mkdir", { path: sftpPathSchema }),
    /**
     * `overwrite: false`: цель не должна существовать (иначе `exists`). `overwrite: true`: атомарная замена, которую
     * может только сервер с расширением posix-rename. Без него `overwrite: true` ВСЕГДА `unsupported`, есть цель или нет:
     * Remote Hub не эмулирует remove+rename и не отвечает по тому, что лежит на сервере.
     */
    onChannel("rename", { from: sftpPathSchema, to: sftpPathSchema, overwrite: z.boolean() }),
    /** Удаляет один файл или ОДИН ПУСТОЙ каталог; рекурсии на сервере нет. */
    onChannel("remove", { path: sftpPathSchema, kind: z.enum(["file", "dir"]) }),
  ]),
  writeSchema,
]);
export type SftpOpInput = z.infer<typeof sftpOpInputSchema>;
export type SftpOp = SftpOpInput["op"];

const NEEDED: Record<SftpOp, SftpLevel> = {
  list: "read", stat: "read", realpath: "read", read: "read",
  write: "write", mkdir: "write", rename: "write", remove: "write",
};
export function neededLevel(op: SftpOp): SftpLevel {
  return NEEDED[op];
}

export const sftpOpOutputSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("list"),
    entries: z.array(z.object({ name: sftpPathSchema, attrs: sftpAttrsSchema }).strict()).max(SFTP_LIMITS.listPage),
    nextCursor: z.string().nullable(),
  }).strict(),
  z.object({ op: z.literal("stat"), attrs: sftpAttrsSchema }).strict(),
  z.object({ op: z.literal("realpath"), path: sftpPathSchema }).strict(),
  /** `eof`: кусок дошёл до конца файла (он может быть короче запрошенного или пустым). */
  z.object({ op: z.literal("read"), data: base64Schema(SFTP_LIMITS.chunkBytes), eof: z.boolean() }).strict(),
  z.object({ op: z.literal("write"), written: z.number().int().min(0).max(SFTP_LIMITS.chunkBytes) }).strict(),
  z.object({ op: z.literal("mkdir") }).strict(),
  z.object({ op: z.literal("rename") }).strict(),
  z.object({ op: z.literal("remove") }).strict(),
]);
export type SftpOpOutput = z.infer<typeof sftpOpOutputSchema>;

const consent = z.enum(["none", "pending", "granted", "revoked"]);
const level = z.enum(SFTP_LEVELS);

/** Шесть вызовов. Каждый отказывает вызывающему, который не плагин, кодом `caller_not_plugin`. */
export const sftpMethods = {
  /** Сохранённые SSH-подключения без секретов и то, что ЭТОТ плагин может с каждым делать. */
  hub_sftp_profiles: {
    input: z.object({}).strict(),
    output: z.object({
      profiles: z.array(
        z.object({
          id: profileId,
          name: z.string(),
          group: z.string().nullable(),
          host: z.string(),
          port: z.number().int().min(1).max(65535),
          user: z.string().nullable(),
          authType: z.enum(["agent", "key", "password"]),
          consent,
          /** Выданный уровень; null, если `consent` не "granted". */
          level: level.nullable(),
          hostKey: z.enum(["trusted", "unknown", "changed"]),
          /** Подключение идёт через SSH-конфиг владельца так, что SFTP не может пройти: open отказывает. */
          needsConfig: z.boolean(),
        }).strict(),
      ),
    }).strict(),
  },
  /** Ставит запрос перед владельцем. Ничего не выдаёт; повтор для того же профиля и уровня возвращает тот же запрос. */
  hub_sftp_request_access: {
    input: z.object({ profileId, level, reason: z.string().max(SFTP_LIMITS.reasonChars).optional() }).strict(),
    output: z.object({ requestId: z.string().uuid(), state: z.enum(["pending", "granted"]) }).strict(),
  },
  hub_sftp_grants: {
    input: z.object({}).strict(),
    output: z.object({
      grants: z.array(z.object({
        profileId,
        level,
        state: z.enum(["pending", "granted", "revoked"]),
        /** ISO-время; null, пока ожидает. */
        grantedAt: z.string().nullable(),
      }).strict()),
    }).strict(),
  },
  /** Открывает канал после проверки гранта и ключа сервера. Канал умирает вместе с поколением helper-а. */
  hub_sftp_open: {
    input: z.object({ profileId }).strict(),
    output: z.object({ channelId, generation }).strict(),
  },
  hub_sftp_op: { input: sftpOpInputSchema, output: sftpOpOutputSchema },
  hub_sftp_close: {
    input: z.object({ channelId }).strict(),
    output: z.object({ closed: z.boolean() }).strict(),
  },
} as const;

export type SftpMethodName = keyof typeof sftpMethods;
export type SftpInput<M extends SftpMethodName> = z.infer<(typeof sftpMethods)[M]["input"]>;
export type SftpOutput<M extends SftpMethodName> = z.infer<(typeof sftpMethods)[M]["output"]>;

/**
 * Стабильные коды отказа. Отказ — `experimental_PluginRpcRefusal` хоста с классом справа; сообщение
 * НАЧИНАЕТСЯ с кода и ": ". Сообщения никогда не несут путь к ключу, текст запроса или имя Keychain.
 */
export const SFTP_REFUSALS = {
  caller_not_plugin: "forbidden",
  consent_required: "forbidden",
  consent_revoked: "forbidden",
  /** Ключ сервера пока неизвестен: владелец решает на странице Remote Hub, затем плагин открывает снова. */
  host_key_unknown: "forbidden",
  host_key_changed: "forbidden",
  permission_denied: "forbidden",
  profile_not_found: "not_found",
  /**
   * The channel is gone and the request was NOT sent to the server: for a changing operation nothing was applied.
   * Opening a new channel and repeating is safe.
   */
  channel_closed: "not_found",
  no_such_file: "not_found",
  profile_not_sftp: "invalid",
  limit_exceeded: "invalid",
  invalid_path: "invalid",
  profile_needs_config: "conflict",
  /** Подключение `agent`, а SSH-агент не запущен или не держит ключа, который принимает сервер. */
  agent_unavailable: "conflict",
  keychain_locked: "conflict",
  keychain_needs_approval: "conflict",
  credential_missing: "conflict",
  auth_failed: "conflict",
  unreachable: "conflict",
  exists: "conflict",
  not_empty: "conflict",
  /** Сервер не может сделать запрошенное (атомарная замена без posix-rename). */
  unsupported: "conflict",
  /**
   * Only for a changing operation: the request WAS sent and the channel died before the answer. It may or may not have
   * been applied; Remote Hub does not repeat it.
   */
  outcome_unknown: "conflict",
  failure: "conflict",
} as const satisfies Record<string, "forbidden" | "not_found" | "conflict" | "invalid">;
export type SftpRefusalCode = keyof typeof SFTP_REFUSALS;

/** Отказ Remote Hub. Сообщение начинается с кода и ": " (см. SFTP_REFUSALS). */
export class SftpRefusal extends Error {
  readonly code: SftpRefusalCode;

  /** `detail` is the host's own text; a client must never copy it into what it shows. */
  constructor(code: SftpRefusalCode, detail = "refused by Remote Hub") {
    super(`${code}: ${detail}`);
    this.name = "SftpRefusal";
    this.code = code;
  }
}

/**
 * Узкий порт вызова Remote Hub. Реализация в S7 — через bb.sdk.plugins.callRpc; отказ хоста переводит
 * в SftpRefusal, сбой транспорта остаётся собственной ошибкой.
 */
export interface RemoteHubPort {
  call<M extends SftpMethodName>(method: M, input: SftpInput<M>, signal: AbortSignal): Promise<SftpOutput<M>>;
}

/** События (только идентификаторы) на канале ниже. */
export const SFTP_EVENTS_CHANNEL = "remote-hub.sftp";
export const sftpConsentEventSchema = z.object({ type: z.literal("sftp.consent"), profileId, state: consent }).strict();
export const sftpChannelEventSchema = z.object({
  channelId,
  state: z.enum(["open", "closed", "revoked", "hostkey_changed"]),
}).strict();
