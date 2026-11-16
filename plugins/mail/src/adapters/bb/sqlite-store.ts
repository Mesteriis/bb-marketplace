// Portions ported from Velo (https://github.com/avihaymenahem/velo), src/services/db/migrations.ts, src/services/db/search.ts, src/services/search/searchQueryBuilder.ts, commit ec47a7a5095bb5deffc24e9b6812e39107508dbe, Apache-2.0. Modified for Makosh Mail.
//
// MailStore on the plugin's own SQLite database (better-sqlite3). Semantics
// match the in-memory store in src/core/testing/fakes.ts:
//   - an owner-asked \Seen / \Flagged change waits in `seen_desired` /
//     `flag_desired` (NULL = nothing pending) and wins over server flags
//     until the push clears it; `seen_pending` (slice 1–2) is frozen since
//     migration 3 and no longer read or written;
//   - a folder reset detaches uids (uid = NULL) and keeps message ids; a
//     detached row with the same Message-ID is reattached on upsert;
//   - an undated message counts as inside the sync window and sorts as the
//     newest message of its thread, but a thread's last_date is its latest
//     non-null date (null only when every message is undated);
//   - the threads table is derived from messages and rebuilt whenever the
//     rows it summarizes change, so nothing durable is keyed on a thread id;
//   - one message can have a row in several folders (Gmail labels); rows of
//     one message share `dedup_key`, and thread, folder, badge and search
//     counts count distinct keys (store-rules.ts holds the shared rules);
//   - threads are account-wide; a thread is listed in a folder when it has a
//     row there that is not waiting to move out (`move_pending`);
//   - a move re-homes the row (same id) to the destination; without a uid map
//     the row waits detached there until that folder's sync reattaches it by
//     Gmail id or Message-ID, or deletes it at the end of the round.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AttachmentMeta,
  ComposeAttachment,
  ComposeKind,
  DraftOrigin,
  DraftPurpose,
  DraftRecord,
  DraftServerCopyState,
  OutboxRecord,
  OutboxState,
  SendErrorKind,
  SentCopyPolicy,
  SmtpSecurity,
  FetchedMessage,
  Folder,
  InlinePart,
  MailAddress,
  MessageBody,
  MessageHeader,
  MessageSummary,
  ParsedQuery,
  RawRef,
  RemoteFolder,
  RoleCount,
  SpecialUse,
  StoredAccount,
  SyncState,
  ThreadDetail,
  ThreadingInput,
  ThreadSummary,
  ThreadFilter,
} from "../../core/model.ts";
import type { ComposeDoc } from "../../core/compose-doc.ts";
import type { SignatureDoc } from "../../core/compose-signature.ts";
import { ComposeError } from "../../core/compose.ts";
import { normalizeMessageId } from "../../core/headers.ts";
import {
  IDENTITIES_MAX_PER_ACCOUNT,
  ownerAddressSets,
  resolveSendCheck,
  type AliasRow,
  type InboundRow,
  type SendCheck,
} from "../../core/identities.ts";
import { OPEN_AI_SCOPE, inAiScope, senderExcluded, type AccountScope, type AiScope } from "../../core/ai-scope.ts";
import { redactSecrets } from "../../core/redact.ts";
import { AGENT_LOG_IDS_MAX, AGENT_LOG_KEEP_DAYS, AGENT_LOG_ROWS_MAX, type LogEntry } from "../../core/agent-log.ts";
import type { AiCategoryAnswer } from "../../core/ai-input.ts";
import {
  CATEGORY_RULES_MAX,
  type Category,
  type CategoryRule,
  type CategorySource,
  type PreviousLabel,
} from "../../core/categories.ts";
import { dismissalKey } from "../../core/digest.ts";
import { ANSWERED_KEEP_DAYS, REMINDERS_LIVE_MAX, dueAt, type ReminderState } from "../../core/reminders.ts";
import { TEMPLATES_MAX } from "../../core/templates.ts";
import type { UndoRow } from "../../core/undo.ts";
import { cleanSnippet, needsSnippetRepair, snippetOf } from "../../core/snippet.ts";
import { AI_RESULT_MAX_BYTES, TASKS_OPEN_MAX } from "../../core/ports.ts";
import type {
  AiResultRecord,
  ReminderRecord,
  TaskRecord,
  MailStore,
  ProposalRecord,
  TemplateRecord,
  TranslationRecord,
  TriageBatchRecord,
  TriageItemRecord,
  UnsubscribeRecord,
} from "../../core/ports.ts";
import { matchesBlock, type BlockRule } from "../../core/blocking.ts";
import { SNOOZES_MAX_PER_ACCOUNT, type SnoozeRow, type SnoozeState } from "../../core/snooze.ts";
import type { TriageAction, TriageBatchState, TriageItemOutcome } from "../../core/triage.ts";
import { UNSUBSCRIBE_INFO_MAX_BYTES, type UnsubscribeInfo } from "../../core/unsubscribe.ts";
import type { ProposalCapRow, ProposalState } from "../../core/agent-propose.ts";
import { TRANSLATION_CACHE_ROWS } from "../../core/translate.ts";
import {
  CONTACT_BODY_CHARS,
  CONTACT_SCAN,
  classifyBulk,
  correspondenceOf,
  messageTextMask,
  queryWords,
  rankContacts,
  type ContactMessage,
} from "../../core/contacts.ts";
import {
  capInlineParts,
  compareFolders,
  dedupKeyOf,
  effectiveSpecialUse,
  rankRecipientSuggestions,
  UNIFIED_ROLES,
  type SuggestionEntry,
} from "../../core/store-rules.ts";

/**
 * Append-only migrations for bb.storage.migrate (index = migration id). Each
 * element is one step and may hold several statements; all unapplied steps run
 * in one transaction. BB hashes each statement and rejects a changed one:
 * never edit or reformat a shipped element (whitespace included), only append.
 */
export const MIGRATIONS: string[] = [
  // 0: schema. `seq` is the stable rowid the external-content FTS index uses.
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    password_sealed TEXT NOT NULL,
    preset TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_sync_at TEXT,
    last_error TEXT,
    auth_failed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE sync_state (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder TEXT NOT NULL,
    uid_validity INTEGER NOT NULL,
    last_uid INTEGER NOT NULL,
    synced_since TEXT NOT NULL,
    PRIMARY KEY (account_id, folder)
  );

  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder TEXT NOT NULL,
    uid INTEGER,
    message_id TEXT,
    in_reply_to TEXT,
    refs TEXT NOT NULL DEFAULT '[]',
    thread_id TEXT NOT NULL,
    from_name TEXT,
    from_address TEXT NOT NULL,
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL,
    date TEXT,
    snippet TEXT NOT NULL,
    body_text TEXT,
    body_html TEXT,
    html_truncated INTEGER NOT NULL DEFAULT 0,
    is_read INTEGER NOT NULL DEFAULT 0,
    seen_pending INTEGER NOT NULL DEFAULT 0,
    is_flagged INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    gm_thrid TEXT
  );
  CREATE UNIQUE INDEX messages_folder_uid ON messages(account_id, folder, uid) WHERE uid IS NOT NULL;
  CREATE INDEX messages_message_id ON messages(account_id, message_id);
  CREATE INDEX messages_thread ON messages(thread_id);
  CREATE INDEX messages_date ON messages(account_id, date);

  CREATE TABLE attachments (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    part_id TEXT NOT NULL,
    filename TEXT,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_id TEXT,
    is_inline INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id, part_id)
  );

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    last_date TEXT,
    message_count INTEGER NOT NULL,
    unread_count INTEGER NOT NULL,
    participants_json TEXT NOT NULL,
    snippet TEXT NOT NULL
  );
  CREATE INDEX threads_list ON threads(account_id, last_date, id);
  `,
  // 1: full-text search (Velo migration v2, without the snippet column). The
  // update trigger fires only for indexed columns, so flag and thread updates
  // do not re-tokenize bodies.
  `
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    subject,
    from_name,
    from_address,
    body_text,
    content='messages',
    content_rowid='seq',
    tokenize='trigram'
  );

  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, subject, from_name, from_address, body_text)
    VALUES (new.seq, new.subject, new.from_name, new.from_address, new.body_text);
  END;

  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, body_text)
    VALUES ('delete', old.seq, old.subject, old.from_name, old.from_address, old.body_text);
  END;

  CREATE TRIGGER messages_au AFTER UPDATE OF subject, from_name, from_address, body_text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, body_text)
    VALUES ('delete', old.seq, old.subject, old.from_name, old.from_address, old.body_text);
    INSERT INTO messages_fts(rowid, subject, from_name, from_address, body_text)
    VALUES (new.seq, new.subject, new.from_name, new.from_address, new.body_text);
  END;
  `,
  // 2: slice 2 — folders, cross-folder identity, moves, inline images, image
  // senders. Slice-1 rows get their dedup key here; their INBOX sync_state
  // rows stay valid.
  `
  ALTER TABLE messages ADD COLUMN gm_msgid TEXT;
  ALTER TABLE messages ADD COLUMN dedup_key TEXT NOT NULL DEFAULT '';
  ALTER TABLE messages ADD COLUMN move_pending TEXT;
  ALTER TABLE messages ADD COLUMN move_failures INTEGER NOT NULL DEFAULT 0;
  UPDATE messages SET dedup_key = CASE WHEN message_id IS NOT NULL THEN 'mid:' || message_id || ':' || size ELSE 'id:' || id END;
  CREATE INDEX messages_dedup ON messages(account_id, dedup_key);
  CREATE INDEX messages_folder_pending ON messages(account_id, folder, move_pending);

  CREATE TABLE folders (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    delimiter TEXT NOT NULL,
    special_use TEXT,
    selectable INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (account_id, path)
  );

  CREATE TABLE image_senders (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, address)
  );

  CREATE TABLE inline_parts (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    content_id TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (message_id, content_id)
  );
  `,
  // 3: slice 3a — desired flag state (NULL = no pending change, 0/1 = the
  // value to push) replaces seen_pending, which stays in place, frozen; the
  // thread-date index serves All accounts paging across accounts.
  `
  ALTER TABLE messages ADD COLUMN seen_desired INTEGER;
  ALTER TABLE messages ADD COLUMN flag_desired INTEGER;
  UPDATE messages SET seen_desired = 1 WHERE seen_pending = 1;
  CREATE INDEX threads_last_date ON threads(last_date, id);
  `,
  // 4: slice 3b — SMTP and the Sent-copy policy per account (iCloud and
  // Gmail backfilled from their presets), Reply-To on synced mail (NULL =
  // synced before it was kept), the composer's drafts and attachments, and
  // the outbox (one row per Send, id = the page's requestId; a done row is
  // deleted, so every row is live and a draft has at most one).
  `
  ALTER TABLE accounts ADD COLUMN smtp_host TEXT;
  ALTER TABLE accounts ADD COLUMN smtp_port INTEGER;
  ALTER TABLE accounts ADD COLUMN smtp_security TEXT;
  ALTER TABLE accounts ADD COLUMN smtp_username TEXT;
  ALTER TABLE accounts ADD COLUMN sent_copy TEXT;
  UPDATE accounts SET smtp_host = 'smtp.mail.me.com', smtp_port = 587,
    smtp_security = 'starttls', sent_copy = 'append' WHERE preset = 'icloud';
  UPDATE accounts SET smtp_host = 'smtp.gmail.com', smtp_port = 465,
    smtp_security = 'tls', sent_copy = 'server' WHERE preset = 'gmail';
  UPDATE accounts SET sent_copy = 'append' WHERE sent_copy IS NULL;

  ALTER TABLE messages ADD COLUMN reply_to_json TEXT;

  CREATE TABLE compose_drafts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    source_message_id TEXT,
    message_id TEXT NOT NULL,
    in_reply_to TEXT,
    refs_json TEXT NOT NULL,
    to_json TEXT NOT NULL,
    cc_json TEXT NOT NULL,
    bcc_json TEXT NOT NULL,
    subject TEXT NOT NULL,
    doc_json TEXT NOT NULL,
    import_json TEXT,
    revision INTEGER NOT NULL,
    server_state TEXT NOT NULL DEFAULT 'none',
    server_folder TEXT,
    server_uidvalidity INTEGER,
    server_uid INTEGER,
    server_revision INTEGER,
    server_size INTEGER,
    origin TEXT NOT NULL DEFAULT 'owner',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX compose_drafts_account ON compose_drafts(account_id);
  CREATE INDEX compose_drafts_server ON compose_drafts(account_id, server_folder, server_uid);

  CREATE TABLE compose_attachments (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES compose_drafts(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    content_id TEXT,
    data BLOB NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE INDEX compose_attachments_draft ON compose_attachments(draft_id, position);

  CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    draft_id TEXT,
    message_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    envelope_from TEXT NOT NULL,
    envelope_to_json TEXT NOT NULL,
    mime BLOB NOT NULL,
    bcc_header TEXT,
    state TEXT NOT NULL,
    send_after TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error_kind TEXT,
    rejected_json TEXT NOT NULL DEFAULT '[]',
    origin TEXT NOT NULL DEFAULT 'owner',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX outbox_state ON outbox(state, send_after);
  CREATE UNIQUE INDEX outbox_draft_live ON outbox(draft_id) WHERE draft_id IS NOT NULL;
  `,
  // 5: slice 3c. A hidden draft behind an agent's confirmation card carries
  // its proposal id; proposals keep ids, states and the content hash only (the
  // content is the hidden draft); translations are plain text, one per
  // message and language. No REFERENCES: deletes are explicit.
  `
  ALTER TABLE compose_drafts ADD COLUMN proposal_id TEXT;

  CREATE TABLE agent_proposals (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    draft_id TEXT,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_message_id TEXT,
    added_json TEXT NOT NULL DEFAULT '[]',
    content_sha256 TEXT NOT NULL,
    left_out INTEGER NOT NULL DEFAULT 0,
    view_token_sha256 TEXT,
    viewed_at TEXT,
    state TEXT NOT NULL,
    outbox_id TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX agent_proposals_thread ON agent_proposals(thread_id, state, created_at);

  CREATE TABLE translations (
    message_id TEXT NOT NULL,
    target_language TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    text TEXT NOT NULL,
    truncated INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, target_language)
  );
  CREATE INDEX translations_created ON translations(created_at);
  `,
  // 6: contacts for agents. The bulk mark of a message (mailing list,
  // newsletter, automated mail): 1 bulk, 0 personal, NULL not known (rows
  // synced before this element; they are judged by their sender only).
  `
  ALTER TABLE messages ADD COLUMN bulk INTEGER;
  `,
  // 7: slice 3d — signatures, aliases (identities), the draft's From,
  // Delivered-To of synced mail, templates and the addresses sent to. No
  // REFERENCES: deletes are explicit (deleteAccount).
  `
  ALTER TABLE accounts ADD COLUMN signature_json TEXT;

  CREATE TABLE identities (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    address TEXT NOT NULL,
    display_name TEXT,
    signature_json TEXT,
    state TEXT NOT NULL,
    send_check TEXT NOT NULL DEFAULT 'unknown',
    check_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX identities_account_address ON identities(account_id, address);

  ALTER TABLE compose_drafts ADD COLUMN from_address TEXT;

  ALTER TABLE messages ADD COLUMN delivered_to_json TEXT;

  ALTER TABLE agent_proposals ADD COLUMN template_name TEXT;

  CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    doc_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sent_recipients (
    account_id TEXT NOT NULL,
    address TEXT NOT NULL,
    last_sent_at TEXT NOT NULL,
    PRIMARY KEY (account_id, address)
  );
  `,
  // 8: slice 3e — unsubscribe info of synced mail (NULL = not known), the
  // account's snooze folder, purpose drafts (an unsubscribe email), snoozes,
  // global block rules, unsubscribe requests, dedup keys that reached Spam
  // (block never moves those back), and agent triage batches with their
  // items. No REFERENCES: deletes are explicit.
  `
  ALTER TABLE messages ADD COLUMN unsubscribe_json TEXT;

  ALTER TABLE accounts ADD COLUMN snooze_folder TEXT;

  ALTER TABLE compose_drafts ADD COLUMN purpose TEXT;

  CREATE TABLE snoozes (
    message_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    return_to TEXT NOT NULL,
    due_at TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX snoozes_due ON snoozes(state, due_at);
  CREATE INDEX snoozes_account ON snoozes(account_id);

  CREATE TABLE block_rules (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX block_rules_value ON block_rules(kind, value);

  CREATE TABLE unsubscribes (
    account_id TEXT NOT NULL,
    list_key TEXT NOT NULL,
    method TEXT NOT NULL,
    state TEXT NOT NULL,
    outbox_id TEXT,
    requested_at TEXT NOT NULL,
    PRIMARY KEY (account_id, list_key)
  );

  CREATE TABLE spam_seen (
    account_id TEXT NOT NULL,
    dedup_key TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (account_id, dedup_key)
  );

  CREATE TABLE triage_batches (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    state TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    summary TEXT,
    view_token_hash TEXT,
    approved_json TEXT,
    create_snooze_folder_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX triage_batches_thread ON triage_batches(thread_id, state);

  CREATE TABLE triage_items (
    batch_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    action TEXT NOT NULL,
    snooze_until TEXT,
    note TEXT,
    outcome TEXT,
    PRIMARY KEY (batch_id, position)
  );
  `,
  // Review of slice 3e, item 8: list keys are namespaced, "id:" for a
  // List-Id and "from:" for the From fallback. A stored key with an "@" was a
  // From fallback (a List-Id has none), any other one a List-Id.
  `
  UPDATE messages SET unsubscribe_json = json_set(
      unsubscribe_json, '$.listKey',
      CASE WHEN instr(json_extract(unsubscribe_json, '$.listKey'), '@') > 0 THEN 'from:' ELSE 'id:' END
        || json_extract(unsubscribe_json, '$.listKey'))
    WHERE unsubscribe_json IS NOT NULL AND json_valid(unsubscribe_json)
      AND json_type(unsubscribe_json, '$.listKey') = 'text';

  UPDATE OR IGNORE unsubscribes SET list_key =
      CASE WHEN instr(list_key, '@') > 0 THEN 'from:' ELSE 'id:' END || list_key;
  `,
  // 10: slice 3f — the AI access scope, the agent and AI action log (ids,
  // counts and codes only), cached summaries, kept tasks, local categories
  // with suggestions and rules, the day's digest, reply dismissals and reply
  // reminders. No REFERENCES: deletes are explicit (deleteAccount, deleteRows,
  // purgeDaily).
  `
  CREATE TABLE ai_scope_accounts (
    account_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    folders_json TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE ai_scope_senders (
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (kind, value)
  );

  CREATE TABLE agent_log (
    seq INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    thread_id TEXT,
    tool TEXT NOT NULL,
    outcome TEXT NOT NULL,
    message_ids_json TEXT NOT NULL,
    result_count INTEGER NOT NULL,
    hidden_count INTEGER NOT NULL,
    ref_id TEXT,
    provider TEXT,
    model TEXT
  );
  CREATE INDEX agent_log_at ON agent_log(at);
  CREATE INDEX agent_log_thread ON agent_log(thread_id, at);
  CREATE INDEX agent_log_ref ON agent_log(ref_id);

  CREATE TABLE ai_results (
    kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    result_json TEXT NOT NULL,
    notes_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (kind, subject_id)
  );

  CREATE TABLE mail_tasks (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    message_id TEXT,
    dedup_key TEXT NOT NULL,
    title TEXT NOT NULL,
    due_date TEXT,
    done_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX mail_tasks_open ON mail_tasks(done_at, due_date);

  CREATE TABLE message_categories (
    account_id TEXT NOT NULL,
    dedup_key TEXT NOT NULL,
    category TEXT NOT NULL,
    source TEXT NOT NULL,
    set_at TEXT NOT NULL,
    PRIMARY KEY (account_id, dedup_key)
  );
  CREATE INDEX message_categories_category ON message_categories(category, account_id, dedup_key);
  CREATE TABLE category_suggestions (
    account_id TEXT NOT NULL,
    dedup_key TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, dedup_key)
  );
  CREATE TABLE category_rules (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX category_rules_value ON category_rules(kind, value);

  CREATE TABLE digests (
    day TEXT PRIMARY KEY,
    built_at TEXT NOT NULL,
    since TEXT NOT NULL,
    reply_count INTEGER NOT NULL,
    notice_count INTEGER NOT NULL,
    notified_at TEXT
  );
  CREATE TABLE reply_dismissals (
    account_id TEXT NOT NULL,
    dedup_key TEXT NOT NULL,
    dismissed_at TEXT NOT NULL,
    PRIMARY KEY (account_id, dedup_key)
  );

  CREATE TABLE reply_reminders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    outbox_id TEXT,
    rfc_message_id TEXT NOT NULL,
    thread_id TEXT,
    days INTEGER NOT NULL,
    sent_at TEXT,
    due_at TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    notified_at TEXT
  );
  CREATE INDEX reply_reminders_state ON reply_reminders(state, due_at);
  CREATE INDEX reply_reminders_mid ON reply_reminders(rfc_message_id);
  `,
];

const HTML_CAP = 1_000_000;
/** Delivered-To / X-Original-To addresses kept per message (slice 3d). */
const DELIVERED_TO_MAX = 10;
/** Rows per transaction when stale snippets are repaired on load. */
const SNIPPET_REPAIR_BATCH = 500;
/** Trigram FTS needs at least three characters; shorter text uses LIKE. */
const FTS_MIN_CHARS = 3;

type AccountRow = {
  id: string;
  email: string;
  display_name: string | null;
  host: string;
  port: number;
  username: string;
  password_sealed: string;
  preset: StoredAccount["preset"];
  created_at: string;
  last_sync_at: string | null;
  last_error: string | null;
  auth_failed: number;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: SmtpSecurity | null;
  smtp_username: string | null;
  sent_copy: SentCopyPolicy | null;
  signature_json: string | null;
  snooze_folder: string | null;
};

type MessageRow = {
  id: string;
  account_id: string;
  folder: string;
  thread_id: string;
  date: string | null;
  from_name: string | null;
  from_address: string;
  subject: string;
  snippet: string;
  is_read: number;
  is_flagged: number;
  has_attachments: number;
};

type HeaderRow = MessageRow & { to_json: string; cc_json: string; uid: number | null };

type DraftRow = {
  id: string;
  account_id: string;
  kind: ComposeKind;
  source_message_id: string | null;
  message_id: string;
  in_reply_to: string | null;
  refs_json: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  doc_json: string;
  import_json: string | null;
  revision: number;
  server_state: DraftServerCopyState;
  server_folder: string | null;
  server_uidvalidity: number | null;
  server_uid: number | null;
  server_revision: number | null;
  server_size: number | null;
  origin: DraftOrigin;
  proposal_id: string | null;
  from_address: string | null;
  purpose: DraftPurpose | null;
  created_at: string;
  updated_at: string;
};

type SnoozeDbRow = {
  message_id: string;
  account_id: string;
  return_to: string;
  due_at: string;
  state: SnoozeState;
  created_at: string;
  updated_at: string;
};

function toSnooze(row: SnoozeDbRow): SnoozeRow {
  return { messageId: row.message_id, accountId: row.account_id, returnTo: row.return_to, dueAt: row.due_at, state: row.state };
}

type BlockRuleDbRow = { id: string; kind: BlockRule["kind"]; value: string; created_at: string };

function toBlockRule(row: BlockRuleDbRow): BlockRule {
  return { id: row.id, kind: row.kind, value: row.value, createdAt: row.created_at };
}

type UnsubscribeDbRow = {
  account_id: string;
  list_key: string;
  method: UnsubscribeRecord["method"];
  state: UnsubscribeRecord["state"];
  outbox_id: string | null;
  requested_at: string;
};

function toUnsubscribe(row: UnsubscribeDbRow): UnsubscribeRecord {
  return {
    accountId: row.account_id,
    listKey: row.list_key,
    method: row.method,
    state: row.state,
    outboxId: row.outbox_id,
    requestedAt: row.requested_at,
  };
}

type TriageBatchDbRow = {
  id: string;
  thread_id: string;
  state: TriageBatchState;
  content_hash: string;
  summary: string | null;
  view_token_hash: string | null;
  approved_json: string | null;
  create_snooze_folder_json: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

function toTriageBatch(row: TriageBatchDbRow): TriageBatchRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    state: row.state,
    contentHash: row.content_hash,
    summary: row.summary,
    viewTokenHash: row.view_token_hash,
    approved: row.approved_json === null ? null : (JSON.parse(row.approved_json) as number[]),
    createSnoozeFolder:
      row.create_snooze_folder_json === null ? null : (JSON.parse(row.create_snooze_folder_json) as string[]),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

type TriageItemDbRow = {
  batch_id: string;
  position: number;
  message_id: string;
  account_id: string;
  action: TriageAction;
  snooze_until: string | null;
  note: string | null;
  outcome: TriageItemOutcome | null;
};

function toTriageItem(row: TriageItemDbRow): TriageItemRecord {
  return {
    batchId: row.batch_id,
    position: row.position,
    messageId: row.message_id,
    accountId: row.account_id,
    action: row.action,
    snoozeUntil: row.snooze_until,
    note: row.note,
    outcome: row.outcome,
  };
}

type IdentityRow = {
  id: string;
  account_id: string;
  address: string;
  display_name: string | null;
  signature_json: string | null;
  state: AliasRow["state"];
  send_check: SendCheck;
  check_message_id: string | null;
  created_at: string;
  updated_at: string;
};

type TemplateRow = {
  id: string;
  name: string;
  name_key: string;
  doc_json: string;
  created_at: string;
  updated_at: string;
};

type ProposalRow = {
  id: string;
  thread_id: string;
  draft_id: string | null;
  account_id: string;
  kind: ComposeKind;
  source_message_id: string | null;
  added_json: string;
  content_sha256: string;
  left_out: number;
  view_token_sha256: string | null;
  viewed_at: string | null;
  state: ProposalState;
  outbox_id: string | null;
  template_name: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

type TranslationRow = {
  message_id: string;
  target_language: string;
  source_sha256: string;
  provider_id: string;
  model: string;
  text: string;
  truncated: number;
  created_at: string;
};

type OutboxRow = {
  id: string;
  account_id: string;
  draft_id: string | null;
  message_id: string;
  subject: string;
  envelope_from: string;
  envelope_to_json: string;
  state: OutboxState;
  send_after: string;
  attempts: number;
  error_kind: SendErrorKind | null;
  rejected_json: string;
  origin: DraftOrigin;
  created_at: string;
  updated_at: string;
};

type ComposeAttachmentRow = {
  id: string;
  file_name: string;
  mime_type: string;
  size: number;
  sha256: string;
  content_id: string | null;
  data: Buffer;
};

/** Outbox columns without the blobs. */
const OUTBOX_COLUMNS = `id, account_id, draft_id, message_id, subject, envelope_from, envelope_to_json,
  state, send_after, attempts, error_kind, rejected_json, origin, created_at, updated_at`;

/** Distinct rows read for recipient suggestions, newest first. */
const SUGGESTION_SCAN = 5000;

type ThreadRow = {
  id: string;
  account_id: string;
  subject: string;
  last_date: string | null;
  message_count: number;
  unread_count: number;
  participants_json: string;
  snippet: string;
};

/** A thread row with whether a message of it in the listed folder is flagged. */
type ListedThreadRow = ThreadRow & { flagged: number; snoozed_until: string | null };

type AttachmentRow = {
  message_id: string;
  part_id: string;
  filename: string | null;
  mime_type: string;
  size: number;
  is_inline: number;
};

const SUMMARY_COLUMNS = `m.id, m.account_id, m.folder, m.thread_id, m.date, m.from_name, m.from_address,
  m.subject, m.snippet, m.is_read, m.is_flagged, m.has_attachments`;

/** Refusals after which a queued move is cancelled. */
const MOVE_MAX_FAILURES = 3;

/** True for a row (alias m) in an Inbox folder of its account. */
const IN_INBOX = `(upper(m.folder) = 'INBOX' OR m.folder IN (
  SELECT f.path FROM folders f WHERE f.account_id = m.account_id AND f.special_use = 'inbox'))`;

/** True for a row (alias m) in the account's All Mail folder. */
const IN_ALL_MAIL = `(m.folder IN (
  SELECT f.path FROM folders f WHERE f.account_id = m.account_id AND f.special_use = 'all'))`;

/**
 * The effective special use of a row (alias m) joined with its folder
 * (alias f, LEFT JOIN): the saved special use, else Inbox for INBOX
 * (store-rules effectiveSpecialUse).
 */
const ROW_ROLE = `CASE WHEN f.special_use IS NOT NULL THEN f.special_use
  WHEN upper(m.folder) = 'INBOX' THEN 'inbox' END`;

/**
 * The effective special use of a row (alias m) without a folder join: the
 * saved special use, else Inbox for INBOX (as ROW_ROLE).
 */
const SCOPE_ROLE = `COALESCE((SELECT sf.special_use FROM folders sf WHERE sf.account_id = m.account_id AND sf.path = m.folder),
  CASE WHEN upper(m.folder) = 'INBOX' THEN 'inbox' END)`;

/** True for a row (alias m) inside the installed AI access scope (slice 3f). */
const IN_AI_SCOPE = `mail_ai_in_scope(m.account_id, m.folder, ${SCOPE_ROLE}, m.from_address, m.to_json, m.cc_json, m.thread_id) = 1`;

/**
 * True for a row (alias m) inside the scope, or whose Gmail All Mail copy is
 * (spec resolution 17: a message is shared when any of its labels or All
 * Mail is chosen).
 */
const IN_AI_SCOPE_OR_ALL_MAIL = `(${IN_AI_SCOPE} OR EXISTS (
  SELECT 1 FROM messages c WHERE c.account_id = m.account_id AND c.dedup_key = m.dedup_key AND c.id <> m.id
    AND ${IN_ALL_MAIL.replace(/\bm\./g, "c.")} AND ${IN_AI_SCOPE.replace(/\bm\./g, "c.")}))`;

/** What a contact lookup reads of a message (alias m, folder alias f). */
const CONTACT_COLUMNS = `m.account_id, m.dedup_key, m.date, m.from_name, m.from_address, m.to_json, m.cc_json,
  m.bulk, ${ROW_ROLE} AS role`;

/** Messages a contact lookup counts: not moving, not marked bulk, not in junk or trash. */
const CONTACT_ROWS = `m.move_pending IS NULL AND m.bulk IS NOT 1
  AND COALESCE(${ROW_ROLE}, '') NOT IN ('junk', 'trash')`;

type ContactRow = {
  account_id: string;
  dedup_key: string;
  date: string | null;
  from_name: string | null;
  from_address: string;
  to_json: string;
  cc_json: string;
  bulk: number | null;
  role: string | null;
  mask: number;
};

function toContactMessage(row: ContactRow): ContactMessage {
  return {
    accountId: row.account_id,
    dedupKey: row.dedup_key,
    date: row.date,
    from: { name: row.from_name, address: row.from_address },
    to: JSON.parse(row.to_json) as MailAddress[],
    cc: JSON.parse(row.cc_json) as MailAddress[],
    inSent: row.role === "sent",
    bulk: row.bulk === null ? null : row.bulk === 1,
    textMask: row.mask,
  };
}

/** Messages (alias m) with their folder row (alias f). */
const MESSAGES_WITH_FOLDER = `messages m LEFT JOIN folders f
  ON f.account_id = m.account_id AND f.path = m.folder`;

/** Oldest first; an undated message sorts after every dated one. */
const OLDEST_FIRST = "date IS NULL, date, id";

function newMessageId(): string {
  return `m_${randomBytes(8).toString("hex")}`;
}

/** ISO 8601 in UTC, so text order is time order; null when unparseable. */
function normalizeDate(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** An ISO time as stored: normalized to UTC so text order is time order. */
function isoOf(raw: string): string {
  return normalizeDate(raw) ?? raw;
}

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The whole text as one FTS5 phrase, so operators and quotes are literal. */
function ftsPhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

function encodeCursor(lastDate: string | null, id: string): string {
  return Buffer.from(`${lastDate ?? ""}|${id}`, "utf8").toString("base64");
}

function decodeCursor(cursor: string): { lastDate: string | null; id: string } | null {
  const raw = Buffer.from(cursor, "base64").toString("utf8");
  const bar = raw.indexOf("|");
  if (bar < 0) return null;
  const lastDate = raw.slice(0, bar);
  return { lastDate: lastDate === "" ? null : lastDate, id: raw.slice(bar + 1) };
}

function toAccount(row: AccountRow): StoredAccount {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    preset: row.preset,
    host: row.host,
    port: row.port,
    username: row.username,
    createdAt: row.created_at,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    authFailed: row.auth_failed === 1,
    passwordSealed: row.password_sealed,
    smtp:
      row.smtp_host !== null && row.smtp_port !== null && row.smtp_security !== null
        ? {
            host: row.smtp_host,
            port: row.smtp_port,
            security: row.smtp_security,
            username: row.smtp_username,
          }
        : null,
    sentCopy: row.sent_copy ?? "append",
    signature: row.signature_json === null ? null : (JSON.parse(row.signature_json) as SignatureDoc),
    snoozeFolder: row.snooze_folder,
  };
}

function toDraft(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    sourceMessageId: row.source_message_id,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: JSON.parse(row.refs_json) as string[],
    to: JSON.parse(row.to_json) as MailAddress[],
    cc: JSON.parse(row.cc_json) as MailAddress[],
    bcc: JSON.parse(row.bcc_json) as MailAddress[],
    subject: row.subject,
    doc: JSON.parse(row.doc_json) as ComposeDoc,
    importHtml:
      row.import_json === null ? null : (JSON.parse(row.import_json) as DraftRecord["importHtml"]),
    serverCopy:
      row.server_folder !== null &&
      row.server_uidvalidity !== null &&
      row.server_uid !== null &&
      row.server_revision !== null &&
      row.server_size !== null
        ? {
            folder: row.server_folder,
            uidValidity: row.server_uidvalidity,
            uid: row.server_uid,
            revision: row.server_revision,
            size: row.server_size,
          }
        : null,
    origin: row.origin,
    proposalId: row.proposal_id,
    purpose: row.purpose,
    fromAddress: row.from_address,
    createdAt: row.created_at,
    revision: row.revision,
    serverState: row.server_state,
    updatedAt: row.updated_at,
  };
}

function toAlias(row: IdentityRow): AliasRow {
  return {
    id: row.id,
    accountId: row.account_id,
    address: row.address,
    displayName: row.display_name,
    signature: row.signature_json === null ? null : (JSON.parse(row.signature_json) as SignatureDoc),
    state: row.state,
    sendCheck: row.send_check,
    checkMessageId: row.check_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTemplate(row: TemplateRow): TemplateRecord {
  return {
    id: row.id,
    name: row.name,
    nameKey: row.name_key,
    doc: JSON.parse(row.doc_json) as ComposeDoc,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function newIdentityId(): string {
  return `ident_${randomBytes(8).toString("hex")}`;
}

/** Delivered-To / X-Original-To as stored: lower case, distinct, at most 10; null when the fetch read no headers. */
/** `unsubscribe_json` of a fetched message: NULL without info or over UNSUBSCRIBE_INFO_MAX_BYTES. */
function unsubscribeJson(info: UnsubscribeInfo | null | undefined): string | null {
  if (info === undefined || info === null) return null;
  const json = JSON.stringify(info);
  return Buffer.byteLength(json, "utf8") > UNSUBSCRIBE_INFO_MAX_BYTES ? null : json;
}

/**
 * The quick filters as one condition on a member row `m` (spec resolution
 * 20): every requested flag on the same row, or the kept thread's row.
 * Empty when nothing narrows the list.
 */
function filterCondition(filter: ThreadFilter | undefined): string {
  const flags = [
    filter?.unread === true ? "m.is_read = 0" : null,
    filter?.flagged === true ? "m.is_flagged = 1" : null,
    filter?.attachments === true ? "m.has_attachments = 1" : null,
    // Slice 3f: an uncorrelated list of labelled (account, dedup key) pairs.
    filter?.category === undefined
      ? null
      : "(m.account_id, m.dedup_key) IN (SELECT account_id, dedup_key FROM message_categories WHERE category = @category)",
  ].filter((part): part is string => part !== null);
  if (flags.length === 0) return "";
  const keep = filter?.keep === undefined ? "" : " OR m.thread_id = @keep";
  return ` AND ((${flags.join(" AND ")})${keep})`;
}

function filterParams(filter: ThreadFilter | undefined): Record<string, string> {
  return {
    ...(filter?.keep === undefined ? {} : { keep: filter.keep }),
    ...(filter?.category === undefined ? {} : { category: filter.category }),
  };
}

function deliveredToJson(addresses: string[] | undefined): string | null {
  if (addresses === undefined) return null;
  const out = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => a !== ""))].slice(0, DELIVERED_TO_MAX);
  return JSON.stringify(out);
}

function toProposal(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    draftId: row.draft_id,
    accountId: row.account_id,
    kind: row.kind,
    sourceMessageId: row.source_message_id,
    added: JSON.parse(row.added_json) as string[],
    contentSha256: row.content_sha256,
    leftOut: row.left_out,
    templateName: row.template_name,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    state: row.state,
    viewTokenSha256: row.view_token_sha256,
    viewedAt: row.viewed_at,
    outboxId: row.outbox_id,
    updatedAt: row.updated_at,
  };
}

function toTranslation(row: TranslationRow): TranslationRecord {
  return {
    messageId: row.message_id,
    targetLanguage: row.target_language,
    providerId: row.provider_id,
    model: row.model,
    text: row.text,
    truncated: row.truncated === 1,
    sourceSha256: row.source_sha256,
    createdAt: row.created_at,
  };
}

function toOutbox(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    draftId: row.draft_id,
    messageId: row.message_id,
    subject: row.subject,
    envelopeFrom: row.envelope_from,
    envelopeTo: JSON.parse(row.envelope_to_json) as string[],
    sendAfter: row.send_after,
    origin: row.origin,
    createdAt: row.created_at,
    state: row.state,
    attempts: row.attempts,
    errorKind: row.error_kind,
    rejected: JSON.parse(row.rejected_json) as string[],
    updatedAt: row.updated_at,
  };
}

function newAttachmentId(): string {
  return `att_${randomBytes(8).toString("hex")}`;
}

function bytesOf(data: Buffer): Uint8Array {
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

function toSummary(row: MessageRow): MessageSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    folder: row.folder,
    threadId: row.thread_id,
    date: row.date,
    from: { name: row.from_name, address: row.from_address },
    subject: row.subject,
    snippet: row.snippet,
    isRead: row.is_read === 1,
    isFlagged: row.is_flagged === 1,
    hasAttachments: row.has_attachments === 1,
  };
}

// ---- Slice 3f rows ----

/** Digests and reply dismissals kept by the daily purge. */
const DAY_ROWS_KEEP_DAYS = 60;

type AgentLogRow = {
  seq: number;
  at: string;
  actor: LogEntry["actor"];
  thread_id: string | null;
  tool: LogEntry["tool"];
  outcome: LogEntry["outcome"];
  message_ids_json: string;
  result_count: number;
  hidden_count: number;
  ref_id: string | null;
  provider: string | null;
  model: string | null;
};

function toLogEntry(row: AgentLogRow): LogEntry & { seq: number } {
  return {
    seq: row.seq,
    at: row.at,
    actor: row.actor,
    threadId: row.thread_id,
    tool: row.tool,
    outcome: row.outcome,
    messageIds: JSON.parse(row.message_ids_json) as string[],
    count: row.result_count,
    hiddenCount: row.hidden_count,
    refId: row.ref_id,
    provider: row.provider,
    model: row.model,
  };
}

type AiResultRow = {
  kind: "summary";
  subject_id: string;
  account_id: string;
  source_sha256: string;
  provider: string;
  model: string;
  result_json: string;
  notes_json: string;
  created_at: string;
};

function toAiResult(row: AiResultRow): AiResultRecord {
  return {
    kind: row.kind,
    subjectId: row.subject_id,
    accountId: row.account_id,
    sourceSha256: row.source_sha256,
    provider: row.provider,
    model: row.model,
    resultJson: row.result_json,
    notesJson: row.notes_json,
    createdAt: row.created_at,
  };
}

type TaskRow = {
  id: string;
  account_id: string;
  message_id: string | null;
  dedup_key: string;
  title: string;
  due_date: string | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
  thread_id: string | null;
};

function toTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    messageId: row.message_id,
    dedupKey: row.dedup_key,
    title: row.title,
    due: row.due_date,
    createdAt: row.created_at,
    threadId: row.message_id === null ? null : row.thread_id,
    doneAt: row.done_at,
    updatedAt: row.updated_at,
    note: null,
  };
}

type CategoryRuleRow = { id: string; kind: CategoryRule["kind"]; value: string; category: Category; created_at: string };

function toCategoryRule(row: CategoryRuleRow): CategoryRule {
  return { id: row.id, kind: row.kind, value: row.value, category: row.category, createdAt: row.created_at };
}

type ReplyCandidateRow = {
  thread_id: string;
  account_id: string;
  id: string;
  dedup_key: string;
  date: string;
  role: SpecialUse | null;
  from_address: string;
  to_json: string;
  cc_json: string;
  bulk: number | null;
  last_sent: string | null;
};

type DigestRow = {
  day: string;
  built_at: string;
  since: string;
  reply_count: number;
  notice_count: number;
  notified_at: string | null;
};

type ReminderRow = {
  id: string;
  account_id: string;
  outbox_id: string | null;
  rfc_message_id: string;
  thread_id: string | null;
  days: number;
  sent_at: string | null;
  due_at: string | null;
  state: ReminderState;
  created_at: string;
  updated_at: string;
  notified_at: string | null;
};

function toReminder(row: ReminderRow): ReminderRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    outboxId: row.outbox_id,
    rfcMessageId: row.rfc_message_id,
    threadId: row.thread_id,
    days: row.days,
    sentAt: row.sent_at,
    dueAt: row.due_at,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notifiedAt: row.notified_at,
  };
}

type AnsweringDbRow = {
  id: string;
  account_id: string;
  thread_id: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  refs: string;
  date: string | null;
  bulk: number | null;
  from_address: string;
};

/** `flagged` covers the thread's messages in the viewed folder. */
function toThread(
  row: ThreadRow,
  flagged: boolean,
  snoozedUntil: string | null = null,
  labels: { category: Category | null; suggestion: AiCategoryAnswer | null } = { category: null, suggestion: null },
): ThreadSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    subject: row.subject,
    lastDate: row.last_date,
    messageCount: row.message_count,
    unreadCount: row.unread_count,
    participants: JSON.parse(row.participants_json) as MailAddress[],
    snippet: row.snippet,
    flagged,
    snoozedUntil,
    category: labels.category,
    // "none" is the model's answer, not a category.
    categorySuggestion: labels.suggestion === null || labels.suggestion === "none" ? null : labels.suggestion,
    projectId: null,
  };
}

function toAttachment(row: AttachmentRow): AttachmentMeta {
  return {
    partId: row.part_id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    isInline: row.is_inline === 1,
  };
}

export function createSqliteStore(db: Database.Database): MailStore {
  /** Runs fn atomically; nests as a savepoint inside a caller's transaction. */
  const atomic = <T>(fn: () => T): T => db.transaction(fn)();
  const proposalCapRows = (nowIso: string): ProposalCapRow[] => {
    const since = new Date(Date.parse(nowIso) - 24 * 60 * 60 * 1000).toISOString();
    return db
      .prepare<[string], { thread_id: string; state: ProposalState; created_at: string; updated_at: string }>(
        `SELECT thread_id, state, created_at, updated_at FROM agent_proposals
         WHERE state IN ('pending', 'confirming') OR created_at > ?
         ORDER BY created_at, id`,
      )
      .all(since)
      .map((row) => ({ threadId: row.thread_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at }));
  };
  // SQLite's LIKE folds ASCII case only; this folds Cyrillic and the rest.
  db.function("mail_lower", { deterministic: true }, (value: unknown) =>
    value === null || value === undefined ? null : String(value).toLowerCase(),
  );
  // The query words arrive as JSON; the parse is kept for the rows of one statement.
  let maskWords: { json: string; words: string[] } = { json: "[]", words: [] };
  db.function("mail_contact_mask", { deterministic: true }, (subject: unknown, snippet: unknown, body: unknown, json: unknown) => {
    if (json !== maskWords.json) maskWords = { json: String(json), words: JSON.parse(String(json)) as string[] };
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    return messageTextMask(text(subject), text(snippet), text(body), maskWords.words);
  });
  // The AI access scope (slice 3f, spec resolution 12): installed by the
  // server with setAiScope, read by agent paths through mail_ai_in_scope.
  let aiScope: AiScope = OPEN_AI_SCOPE;
  let excludedThreads: ReadonlySet<string> = new Set();
  const sendersExcluded = () => aiScope.senders.addresses.size > 0 || aiScope.senders.domains.size > 0;
  const addressesOf = (json: unknown): string[] => {
    if (typeof json !== "string") return [];
    try {
      return (JSON.parse(json) as MailAddress[]).map((a) => a.address);
    } catch {
      return [];
    }
  };
  db.function("mail_sender_excluded", { deterministic: false }, (from: unknown, to: unknown, cc: unknown) =>
    senderExcluded([String(from ?? ""), ...addressesOf(to), ...addressesOf(cc)], aiScope) ? 1 : 0,
  );
  db.function(
    "mail_ai_in_scope",
    { deterministic: false },
    (accountId: unknown, folder: unknown, role: unknown, from: unknown, to: unknown, cc: unknown, threadId: unknown) => {
      const withSenders = sendersExcluded();
      return inAiScope(
        {
          accountId: String(accountId),
          folder: String(folder),
          folderRole: typeof role === "string" ? (role as SpecialUse) : null,
          fromAddress: String(from ?? ""),
          to: withSenders ? addressesOf(to) : [],
          cc: withSenders ? addressesOf(cc) : [],
          threadId: typeof threadId === "string" ? threadId : null,
        },
        aiScope,
        excludedThreads,
      )
        ? 1
        : 0;
    },
  );
  /** Some copy of the row's message (account, dedup key) is inside the AI scope. */
  const anyCopyInScope = db.prepare<[string], { one: number }>(
    `SELECT 1 AS one FROM messages c JOIN messages m ON m.account_id = c.account_id AND m.dedup_key = c.dedup_key
     WHERE c.id = ? AND ${IN_AI_SCOPE} LIMIT 1`,
  );
  /**
   * New rows or threads since the excluded conversations were built: the next
   * scoped read rebuilds them first, so a conversation an excluded sender
   * just joined is out before the round ends (or when it fails).
   */
  let excludedStale = false;
  function freshScope(): void {
    if (!excludedStale) return;
    excludedStale = false;
    rebuildExcludedThreads();
  }
  /** Rebuilds the conversations holding mail of an excluded sender. */
  function rebuildExcludedThreads(): void {
    excludedStale = false;
    excludedThreads = sendersExcluded()
      ? new Set(
          db
            .prepare<[], { thread_id: string }>(
              "SELECT DISTINCT thread_id FROM messages WHERE mail_sender_excluded(from_address, to_json, cc_json) = 1",
            )
            .all()
            .map((row) => row.thread_id),
        )
      : new Set();
  }
  /**
   * The owner's accounts as a contact lookup needs them, in listAccounts
   * order: the email, the username when it holds `@`, and the active
   * aliases (spec resolution 11).
   */
  const ownerAccounts = () => ownerAddressSets(store.listAccounts(), store.listIdentities(null));
  const accountById = db.prepare<[string], AccountRow>("SELECT * FROM accounts WHERE id = ?");
  const activeAlias = db.prepare<[string, string], IdentityRow>(
    "SELECT * FROM identities WHERE account_id = ? AND address = ? AND state = 'active'",
  );

  const findAttached = db.prepare<[string, string, number], { id: string }>(
    "SELECT id FROM messages WHERE account_id = ? AND folder = ? AND uid = ?",
  );
  const findDetached = db.prepare<[string, string, string], { id: string }>(
    `SELECT id FROM messages
     WHERE account_id = ? AND folder = ? AND uid IS NULL AND message_id = ?
     ORDER BY seq LIMIT 1`,
  );
  const findDetachedByGmail = db.prepare<[string, string, string], { id: string }>(
    `SELECT id FROM messages
     WHERE account_id = ? AND folder = ? AND uid IS NULL AND gm_msgid = ?
     ORDER BY seq LIMIT 1`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages (id, account_id, folder, uid, message_id, in_reply_to, refs, thread_id,
       from_name, from_address, to_json, cc_json, subject, date, snippet, body_text, body_html,
       html_truncated, is_read, is_flagged, has_attachments, size, gm_thrid, gm_msgid, dedup_key,
       reply_to_json, bulk, delivered_to_json, unsubscribe_json)
     VALUES (@id, @accountId, @folder, @uid, @messageId, @inReplyTo, @refs, @threadId,
       @fromName, @fromAddress, @toJson, @ccJson, @subject, @date, @snippet, @bodyText, @bodyHtml,
       @htmlTruncated, @seen, @flagged, @hasAttachments, @size, @gmThreadId, @gmMsgId, @dedupKey,
       @replyToJson, @bulk, @deliveredTo, @unsubscribe)`,
  );
  const updateMessage = db.prepare(
    `UPDATE messages SET uid = @uid, message_id = @messageId, in_reply_to = @inReplyTo,
       refs = @refs, from_name = @fromName, from_address = @fromAddress, to_json = @toJson,
       cc_json = @ccJson, reply_to_json = @replyToJson, subject = @subject, date = @date, snippet = @snippet,
       body_text = @bodyText, body_html = @bodyHtml, html_truncated = @htmlTruncated,
       is_read = COALESCE(seen_desired, @seen), is_flagged = COALESCE(flag_desired, @flagged),
       has_attachments = @hasAttachments, size = @size, gm_thrid = @gmThreadId, bulk = @bulk,
       delivered_to_json = COALESCE(@deliveredTo, delivered_to_json),
       unsubscribe_json = CASE WHEN @unsubscribeKnown = 1 THEN @unsubscribe ELSE unsubscribe_json END,
       gm_msgid = COALESCE(@gmMsgId, gm_msgid),
       dedup_key = CASE
         WHEN COALESCE(@gmMsgId, gm_msgid) IS NOT NULL THEN 'gm:' || COALESCE(@gmMsgId, gm_msgid)
         WHEN @messageId IS NOT NULL THEN 'mid:' || @messageId || ':' || @size
         ELSE 'id:' || id END
     WHERE id = @id`,
  );
  const deleteInlinePartsOf = db.prepare("DELETE FROM inline_parts WHERE message_id = ?");
  /** Another row of the account already has this dedup key (a returning message, slice 3e). */
  const dedupTaken = db.prepare<[string, string], { one: number }>(
    "SELECT 1 AS one FROM messages WHERE account_id = ? AND dedup_key = ? LIMIT 1",
  );
  /** The row reached a junk-role folder: block never moves its dedup key back out (spec resolution 17). */
  const markSpamSeen = db.prepare(
    `INSERT INTO spam_seen (account_id, dedup_key, seen_at)
     SELECT account_id, dedup_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM messages WHERE id = ?
     ON CONFLICT(account_id, dedup_key) DO UPDATE SET seen_at = excluded.seen_at`,
  );
  const folderSpecialUse = db.prepare<[string, string], { special_use: SpecialUse | null }>(
    "SELECT special_use FROM folders WHERE account_id = ? AND path = ?",
  );
  /** The folder's effective special use (store-rules effectiveSpecialUse). */
  function folderRole(accountId: string, path: string): SpecialUse | null {
    return effectiveSpecialUse(path, folderSpecialUse.get(accountId, path)?.special_use ?? null);
  }
  const insertInlinePart = db.prepare(
    "INSERT OR IGNORE INTO inline_parts (message_id, content_id, mime_type, data) VALUES (?, ?, ?, ?)",
  );
  const deleteAttachmentsOf = db.prepare("DELETE FROM attachments WHERE message_id = ?");
  const insertAttachment = db.prepare(
    `INSERT OR REPLACE INTO attachments (message_id, part_id, filename, mime_type, size, content_id, is_inline)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  );
  const attachmentsOf = db.prepare<[string], AttachmentRow>(
    "SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid",
  );
  const threadById = db.prepare<[string], ThreadRow>("SELECT * FROM threads WHERE id = ?");
  const draftByServerCopy = db.prepare<[string, string, number], { id: string }>(
    `SELECT id FROM compose_drafts WHERE account_id = ? AND server_folder = ? AND server_uid = ?
     ORDER BY created_at, id LIMIT 1`,
  );
  const draftContinuing = db.prepare<[string], { id: string }>(
    `SELECT id FROM compose_drafts WHERE kind = 'new' AND source_message_id = ?
     ORDER BY created_at, id LIMIT 1`,
  );
  const draftById = db.prepare<[string], DraftRow>("SELECT * FROM compose_drafts WHERE id = ?");
  const outboxById = db.prepare<[string], OutboxRow>(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE id = ?`);
  /** The oldest due queued row of an account not busy (with onlyId, that row only), or null. */
  const dueOutboxId = (now: string, busyAccounts: string[], onlyId?: string): string | null => {
    const due = db
      .prepare<[{ now: string; busy: string; only: string | null }], { id: string }>(
        `SELECT id FROM outbox
         WHERE state = 'queued' AND send_after <= @now
           AND account_id NOT IN (SELECT value FROM json_each(@busy))
           AND (@only IS NULL OR id = @only)
         ORDER BY send_after, created_at, id LIMIT 1`,
      )
      .get({ now, busy: JSON.stringify(busyAccounts), only: onlyId ?? null });
    return due ? due.id : null;
  };
  const draftHeld = db.prepare<[string], { one: number }>(
    "SELECT 1 AS one FROM outbox WHERE draft_id = ? LIMIT 1",
  );
  const deleteDraftRows = (id: string) => {
    db.prepare("DELETE FROM compose_attachments WHERE draft_id = ?").run(id);
    db.prepare("DELETE FROM compose_drafts WHERE id = ?").run(id);
  };
  const proposalById = db.prepare<[string], ProposalRow>("SELECT * FROM agent_proposals WHERE id = ?");
  /** Deletes the proposal's draft only while it is still hidden (an opened one is the owner's), then clears draft_id. */
  const dropHiddenDraft = (id: string) => {
    const row = proposalById.get(id);
    if (!row || row.draft_id === null) return;
    const draft = db
      .prepare<[string], { proposal_id: string | null }>("SELECT proposal_id FROM compose_drafts WHERE id = ?")
      .get(row.draft_id);
    if (draft !== undefined && draft.proposal_id !== id) return;
    if (draft !== undefined) deleteDraftRows(row.draft_id);
    db.prepare("UPDATE agent_proposals SET draft_id = NULL WHERE id = ?").run(id);
  };
  const threadIdOf = db.prepare<[string], { thread_id: string }>(
    "SELECT thread_id FROM messages WHERE id = ?",
  );

  /**
   * Recomputes thread rows from messages: every thread of the account when
   * threadIds is null, else only the given threads.
   */
  function refreshThreads(accountId: string, threadIds: Iterable<string> | null): void {
    const ids = threadIds === null ? null : [...new Set(threadIds)];
    if (ids !== null && ids.length === 0) return;
    if (ids === null) {
      db.prepare("DELETE FROM threads WHERE account_id = ?").run(accountId);
    } else {
      const remove = db.prepare("DELETE FROM threads WHERE id = ?");
      for (const id of ids) remove.run(id);
    }
    type Member = {
      thread_id: string;
      subject: string;
      date: string | null;
      from_name: string | null;
      from_address: string;
      snippet: string;
      is_read: number;
      dedup_key: string;
    };
    const members =
      ids === null
        ? db
            .prepare<[string], Member>(
              `SELECT thread_id, subject, date, from_name, from_address, snippet, is_read, dedup_key
               FROM messages WHERE account_id = ? ORDER BY thread_id, ${OLDEST_FIRST}`,
            )
            .all(accountId)
        : ids.flatMap((id) =>
            db
              .prepare<[string, string], Member>(
                `SELECT thread_id, subject, date, from_name, from_address, snippet, is_read, dedup_key
                 FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY ${OLDEST_FIRST}`,
              )
              .all(accountId, id),
          );
    const groups = new Map<string, Member[]>();
    for (const member of members) {
      const group = groups.get(member.thread_id);
      if (group) group.push(member);
      else groups.set(member.thread_id, [member]);
    }
    const insert = db.prepare(
      `INSERT INTO threads (id, account_id, subject, last_date, message_count, unread_count,
         participants_json, snippet) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [threadId, group] of groups) {
      const latest = group[group.length - 1]!;
      const dated = group.filter((m) => m.date !== null);
      const lastDate = dated.length > 0 ? dated[dated.length - 1]!.date : null;
      const participants: MailAddress[] = [];
      for (const m of group) {
        if (!participants.some((p) => p.address === m.from_address)) {
          participants.push({ name: m.from_name, address: m.from_address });
        }
      }
      insert.run(
        threadId,
        accountId,
        group[0]!.subject,
        lastDate,
        new Set(group.map((m) => m.dedup_key)).size,
        new Set(group.filter((m) => m.is_read === 0).map((m) => m.dedup_key)).size,
        JSON.stringify(participants),
        latest.snippet,
      );
    }
  }

  /** Deletes the given rows with their attachment metadata and inline parts; returns their thread ids. */
  function deleteRows(rows: { id: string; thread_id: string }[]): Set<string> {
    const remove = db.prepare("DELETE FROM messages WHERE id = ?");
    const removeTranslations = db.prepare("DELETE FROM translations WHERE message_id = ?");
    const removeSnooze = db.prepare("DELETE FROM snoozes WHERE message_id = ?");
    // A kept task outlives its message: "no longer in Makosh Mail" (slice 3f).
    const orphanTasks = db.prepare("UPDATE mail_tasks SET message_id = NULL WHERE message_id = ?");
    for (const row of rows) {
      deleteAttachmentsOf.run(row.id);
      deleteInlinePartsOf.run(row.id);
      removeTranslations.run(row.id);
      removeSnooze.run(row.id);
      orphanTasks.run(row.id);
      remove.run(row.id);
    }
    return new Set(rows.map((r) => r.thread_id));
  }

  function header(row: HeaderRow): MessageHeader {
    return {
      ...toSummary(row),
      to: JSON.parse(row.to_json) as MailAddress[],
      cc: JSON.parse(row.cc_json) as MailAddress[],
      attachments: attachmentsOf.all(row.id).map(toAttachment),
      draftId: row.uid === null ? null : (draftByServerCopy.get(row.account_id, row.folder, row.uid)?.id ?? null),
      agentSubject: redactSecrets(row.subject).text,
      inAiScope: (freshScope(), anyCopyInScope.get(row.id) !== undefined),
      devLinks: [],
      dev: null,
      patch: null,
      alert: false,
      bbLinks: [],
    };
  }

  /**
   * The label and model suggestion of a listed thread's latest row in the
   * view (slice 3f): undated rows count as newest, then date, then id (as
   * the fake's oldest-first order). Run per listed thread, outside the
   * listing statement, so its plan stays a plain index scan.
   */
  function labelLookup(query: {
    latest: string;
    params: Record<string, string>;
  }): (threadId: string) => { category: Category | null; suggestion: AiCategoryAnswer | null } {
    const statement = db
      .prepare<[Record<string, unknown>], { category: Category | null; suggestion: AiCategoryAnswer | null }>(
        `SELECT c.category, s.category AS suggestion
         FROM (SELECT l.account_id, l.dedup_key FROM ${query.latest}
               ORDER BY l.date IS NULL DESC, l.date DESC, l.id DESC LIMIT 1) k
         LEFT JOIN message_categories c ON c.account_id = k.account_id AND c.dedup_key = k.dedup_key
         LEFT JOIN category_suggestions s ON s.account_id = k.account_id AND s.dedup_key = k.dedup_key`,
      );
    return (threadId) => {
      const row = statement.get({ ...query.params, threadId });
      return { category: row?.category ?? null, suggestion: row?.suggestion ?? null };
    };
  }

  /**
   * One page of thread rows matching `where`, newest first by
   * (last_date DESC, id DESC) with undated threads last; `flagged` is an SQL
   * boolean over `threads`. The cursor is the last row's (last_date, id).
   */
  function pageThreads(query: {
    where: string;
    flagged: string;
    /** The earliest snooze due time of the thread's rows in scope (slice 3e). */
    snoozed: string;
    /** The thread's rows in scope, alias l, for @threadId (slice 3f): the latest one's label and suggestion. */
    latest: string;
    params: Record<string, string>;
    cursor: string | null;
    limit: number;
  }): { threads: ThreadSummary[]; nextCursor: string | null } {
    const after = query.cursor === null ? null : decodeCursor(query.cursor);
    const columns = `threads.*, ${query.flagged} AS flagged, ${query.snoozed} AS snoozed_until`;
    const params = { ...query.params, limit: query.limit + 1 };
    let rows: ListedThreadRow[];
    if (after === null) {
      rows = db
        .prepare<[Record<string, unknown>], ListedThreadRow>(
          `SELECT ${columns} FROM threads WHERE ${query.where}
           ORDER BY last_date DESC, id DESC LIMIT @limit`,
        )
        .all(params);
    } else if (after.lastDate === null) {
      rows = db
        .prepare<[Record<string, unknown>], ListedThreadRow>(
          `SELECT ${columns} FROM threads WHERE last_date IS NULL AND id < @afterId AND ${query.where}
           ORDER BY id DESC LIMIT @limit`,
        )
        .all({ ...params, afterId: after.id });
    } else {
      rows = db
        .prepare<[Record<string, unknown>], ListedThreadRow>(
          `SELECT ${columns} FROM threads
           WHERE (last_date < @afterDate OR (last_date = @afterDate AND id < @afterId) OR last_date IS NULL)
             AND ${query.where}
           ORDER BY last_date DESC, id DESC LIMIT @limit`,
        )
        .all({ ...params, afterDate: after.lastDate, afterId: after.id });
    }
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const labels = labelLookup(query);
    return {
      threads: page.map((row) => toThread(row, row.flagged === 1, row.snoozed_until, labels(row.id))),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.last_date, last.id) : null,
    };
  }

  const store: MailStore = {
    transaction<T>(fn: () => T): T {
      return atomic(fn);
    },

    // Accounts -------------------------------------------------------------

    listAccounts() {
      return db
        .prepare<[], AccountRow>("SELECT * FROM accounts ORDER BY created_at, id")
        .all()
        .map(toAccount);
    },

    getAccount(id) {
      const row = accountById.get(id);
      return row ? toAccount(row) : null;
    },

    findAccountByEmail(email) {
      const row = db
        .prepare<[string], AccountRow>(
          "SELECT * FROM accounts WHERE lower(email) = lower(?) ORDER BY created_at, id LIMIT 1",
        )
        .get(email);
      return row ? toAccount(row) : null;
    },

    saveAccount(account) {
      // An upsert, never INSERT OR REPLACE: replacing would delete the row
      // and cascade to every message of the account.
      db.prepare(
        `INSERT INTO accounts (id, email, display_name, host, port, username, password_sealed,
           preset, created_at, last_sync_at, last_error, auth_failed,
           smtp_host, smtp_port, smtp_security, smtp_username, sent_copy, signature_json, snooze_folder)
         VALUES (@id, @email, @displayName, @host, @port, @username, @passwordSealed,
           @preset, @createdAt, @lastSyncAt, @lastError, @authFailed,
           @smtpHost, @smtpPort, @smtpSecurity, @smtpUsername, @sentCopy, @signature, @snoozeFolder)
         ON CONFLICT(id) DO UPDATE SET email = excluded.email,
           display_name = excluded.display_name, host = excluded.host, port = excluded.port,
           username = excluded.username, password_sealed = excluded.password_sealed,
           preset = excluded.preset, created_at = excluded.created_at,
           last_sync_at = excluded.last_sync_at, last_error = excluded.last_error,
           auth_failed = excluded.auth_failed, smtp_host = excluded.smtp_host,
           smtp_port = excluded.smtp_port, smtp_security = excluded.smtp_security,
           smtp_username = excluded.smtp_username, sent_copy = excluded.sent_copy,
           signature_json = excluded.signature_json, snooze_folder = excluded.snooze_folder`,
      ).run({
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        host: account.host,
        port: account.port,
        username: account.username,
        passwordSealed: account.passwordSealed,
        preset: account.preset,
        createdAt: account.createdAt,
        lastSyncAt: account.lastSyncAt,
        lastError: account.lastError,
        authFailed: account.authFailed ? 1 : 0,
        smtpHost: account.smtp?.host ?? null,
        smtpPort: account.smtp?.port ?? null,
        smtpSecurity: account.smtp?.security ?? null,
        smtpUsername: account.smtp?.username ?? null,
        sentCopy: account.sentCopy,
        signature: account.signature === null ? null : JSON.stringify(account.signature),
        snoozeFolder: account.snoozeFolder,
      });
    },

    recordSyncResult(id, result) {
      db.prepare(
        "UPDATE accounts SET last_sync_at = ?, last_error = ?, auth_failed = ? WHERE id = ?",
      ).run(result.lastSyncAt, result.lastError, result.authFailed ? 1 : 0, id);
    },

    deleteAccount(id) {
      // Explicit deletes, so the cascade holds even with foreign keys off.
      atomic(() => {
        db.prepare(
          "DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE account_id = ?)",
        ).run(id);
        db.prepare(
          "DELETE FROM inline_parts WHERE message_id IN (SELECT id FROM messages WHERE account_id = ?)",
        ).run(id);
        db.prepare("DELETE FROM folders WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM image_senders WHERE account_id = ?").run(id);
        db.prepare(
          "DELETE FROM translations WHERE message_id IN (SELECT id FROM messages WHERE account_id = ?)",
        ).run(id);
        db.prepare("DELETE FROM messages WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM threads WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM sync_state WHERE account_id = ?").run(id);
        db.prepare(
          "DELETE FROM compose_attachments WHERE draft_id IN (SELECT id FROM compose_drafts WHERE account_id = ?)",
        ).run(id);
        db.prepare("DELETE FROM compose_drafts WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM outbox WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM agent_proposals WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM identities WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM sent_recipients WHERE account_id = ?").run(id);
        // Slice 3e. Block rules are global and stay (spec resolution 5).
        db.prepare("DELETE FROM snoozes WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM unsubscribes WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM spam_seen WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM triage_items WHERE account_id = ?").run(id);
        db.prepare("DELETE FROM triage_batches WHERE id NOT IN (SELECT batch_id FROM triage_items)").run();
        // Slice 3f. agent_log, ai_scope_senders, category_rules and digests are not per account and stay.
        for (const table of [
          "ai_scope_accounts",
          "ai_results",
          "mail_tasks",
          "message_categories",
          "category_suggestions",
          "reply_dismissals",
          "reply_reminders",
        ]) {
          db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(id);
        }
        db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
      });
    },

    // Sync state -----------------------------------------------------------

    getSyncState(accountId, folder) {
      const row = db
        .prepare<
          [string, string],
          { uid_validity: number; last_uid: number; synced_since: string }
        >("SELECT uid_validity, last_uid, synced_since FROM sync_state WHERE account_id = ? AND folder = ?")
        .get(accountId, folder);
      return row
        ? { uidValidity: row.uid_validity, lastUid: row.last_uid, syncedSince: row.synced_since }
        : null;
    },

    saveSyncState(accountId, folder, state: SyncState) {
      db.prepare(
        `INSERT INTO sync_state (account_id, folder, uid_validity, last_uid, synced_since)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, folder) DO UPDATE SET uid_validity = excluded.uid_validity,
           last_uid = excluded.last_uid, synced_since = excluded.synced_since`,
      ).run(accountId, folder, state.uidValidity, state.lastUid, state.syncedSince);
    },

    beginFolderReset(accountId, folder) {
      db.prepare("UPDATE messages SET uid = NULL WHERE account_id = ? AND folder = ?").run(
        accountId,
        folder,
      );
    },

    finishFolderReset(accountId, folder) {
      return atomic(() => {
        const rows = db
          .prepare<[string, string], { id: string; thread_id: string }>(
            "SELECT id, thread_id FROM messages WHERE account_id = ? AND folder = ? AND uid IS NULL",
          )
          .all(accountId, folder);
        if (rows.length === 0) return 0;
        refreshThreads(accountId, deleteRows(rows));
        return rows.length;
      });
    },

    detachedRows(accountId, folder) {
      return db
        .prepare<[string, string], { id: string; message_id: string | null; gm_msgid: string | null }>(
          "SELECT id, message_id, gm_msgid FROM messages WHERE account_id = ? AND folder = ? AND uid IS NULL ORDER BY id",
        )
        .all(accountId, folder)
        .map((row) => ({ id: row.id, messageId: row.message_id, gmMsgId: row.gm_msgid }));
    },

    // Messages -------------------------------------------------------------

    upsertMessages(accountId, folder, messages: FetchedMessage[]) {
      if (sendersExcluded()) excludedStale = true;
      return atomic(() => {
        const touched = new Set<string>();
        const inserted: string[] = [];
        const returning: string[] = [];
        const junk = folderRole(accountId, folder) === "junk";
        for (const message of messages) {
          const html = message.bodyHtml;
          const params = {
            accountId,
            folder,
            uid: message.uid,
            messageId: message.messageId,
            inReplyTo: message.inReplyTo,
            refs: JSON.stringify(message.references),
            fromName: message.from.name,
            fromAddress: message.from.address,
            toJson: JSON.stringify(message.to),
            ccJson: JSON.stringify(message.cc),
            // NULL: not known (a row from before Reply-To was kept, or a fetch without it).
            replyToJson: message.replyTo === undefined ? null : JSON.stringify(message.replyTo),
            subject: message.subject,
            date: normalizeDate(message.date),
            snippet: snippetOf(message.bodyText, message.bodyHtml),
            bodyText: message.bodyText,
            bodyHtml: html !== null && html.length > HTML_CAP ? null : html,
            htmlTruncated: html !== null && html.length > HTML_CAP ? 1 : 0,
            seen: message.seen ? 1 : 0,
            flagged: message.flagged ? 1 : 0,
            hasAttachments: message.attachments.some((a) => !a.isInline) ? 1 : 0,
            size: message.size,
            gmThreadId: message.gmThreadId,
            gmMsgId: message.gmMsgId,
            // NULL: not known (the fetch read no headers).
            bulk: message.bulkHeaders === undefined ? null : classifyBulk(message.bulkHeaders, message.from.address) ? 1 : 0,
            // NULL: not known; an update leaves a known value alone.
            deliveredTo: deliveredToJson(message.deliveredTo),
            // Absent: the fetch read no headers, so an update leaves the stored info alone.
            unsubscribeKnown: message.unsubscribe === undefined ? 0 : 1,
            unsubscribe: unsubscribeJson(message.unsubscribe),
          };
          // A detached row (folder reset, or a move without a uid map) is
          // reattached by Gmail id first, then by Message-ID.
          const existing =
            findAttached.get(accountId, folder, message.uid) ??
            (message.gmMsgId === null
              ? undefined
              : findDetachedByGmail.get(accountId, folder, message.gmMsgId)) ??
            (message.messageId === null
              ? undefined
              : findDetached.get(accountId, folder, message.messageId));
          let id: string;
          if (existing) {
            id = existing.id;
            updateMessage.run({ ...params, id });
          } else {
            id = newMessageId();
            const dedupKey = dedupKeyOf(message.gmMsgId, message.messageId, message.size, id);
            inserted.push(id);
            if (dedupTaken.get(accountId, dedupKey) !== undefined) returning.push(id);
            insertMessage.run({ ...params, id, threadId: `t_${id}`, dedupKey });
          }
          if (junk) markSpamSeen.run(id);
          deleteAttachmentsOf.run(id);
          for (const a of message.attachments) {
            insertAttachment.run(id, a.partId, a.filename, a.mimeType, a.size, a.isInline ? 1 : 0);
          }
          deleteInlinePartsOf.run(id);
          for (const part of capInlineParts(message.inlineParts)) {
            insertInlinePart.run(id, part.contentId, part.mimeType, Buffer.from(part.data));
          }
          touched.add(threadIdOf.get(id)!.thread_id);
        }
        refreshThreads(accountId, touched);
        return { inserted, returning };
      });
    },

    localFolderIndex(accountId, folder, sinceIso) {
      const since = normalizeDate(sinceIso) ?? sinceIso;
      return db
        .prepare<[string, string, string], { uid: number; id: string }>(
          `SELECT uid, id FROM messages
           WHERE account_id = ? AND folder = ? AND uid IS NOT NULL AND (date IS NULL OR date >= ?)
           ORDER BY uid`,
        )
        .all(accountId, folder, since);
    },

    applyFlags(accountId, folder, flags) {
      return atomic(() => {
        const update = db.prepare<
          [{ seen: number; flagged: number; accountId: string; folder: string; uid: number }],
          { thread_id: string }
        >(
          `UPDATE messages
           SET is_read = COALESCE(seen_desired, @seen), is_flagged = COALESCE(flag_desired, @flagged)
           WHERE account_id = @accountId AND folder = @folder AND uid = @uid
             AND (is_read != COALESCE(seen_desired, @seen) OR is_flagged != COALESCE(flag_desired, @flagged))
           RETURNING thread_id`,
        );
        const backfill = db.prepare<
          [{ gmMsgId: string; accountId: string; folder: string; uid: number }],
          { thread_id: string }
        >(
          `UPDATE messages SET gm_msgid = @gmMsgId, dedup_key = 'gm:' || @gmMsgId
           WHERE account_id = @accountId AND folder = @folder AND uid = @uid
             AND (gm_msgid IS NULL OR gm_msgid != @gmMsgId OR dedup_key != 'gm:' || @gmMsgId)
           RETURNING thread_id`,
        );
        const touched = new Set<string>();
        let changed = 0;
        for (const flag of flags) {
          // Uids are unique per folder, so a row comes back only when that one message changed.
          const key = { accountId, folder, uid: flag.uid };
          const row = update.get({ ...key, seen: flag.seen ? 1 : 0, flagged: flag.flagged ? 1 : 0 });
          // A new Gmail id can merge copies, so it counts as a change too.
          const merged =
            flag.gmMsgId === undefined || flag.gmMsgId === null
              ? undefined
              : backfill.get({ ...key, gmMsgId: flag.gmMsgId });
          if (row || merged) {
            changed++;
            touched.add((row ?? merged)!.thread_id);
          }
        }
        refreshThreads(accountId, touched);
        return changed;
      });
    },

    deleteByUids(accountId, folder, uids) {
      return atomic(() => {
        const find = db.prepare<[string, string, number], { id: string; thread_id: string }>(
          "SELECT id, thread_id FROM messages WHERE account_id = ? AND folder = ? AND uid = ?",
        );
        const rows = uids.flatMap((uid) => {
          const row = find.get(accountId, folder, uid);
          return row ? [row] : [];
        });
        if (rows.length === 0) return 0;
        refreshThreads(accountId, deleteRows(rows));
        return rows.length;
      });
    },

    bulkUnknown(accountId, folder, belowUid, limit) {
      if (limit <= 0) return [];
      return db
        .prepare<[string, string, number | null, number | null, number], { uid: number; fromAddress: string }>(
          `SELECT uid, from_address AS fromAddress FROM messages
           WHERE account_id = ? AND folder = ? AND uid IS NOT NULL AND bulk IS NULL AND (? IS NULL OR uid < ?)
           ORDER BY uid DESC LIMIT ?`,
        )
        .all(accountId, folder, belowUid, belowUid, limit);
    },

    fillBulk(accountId, folder, uidValidity, marks) {
      if (marks.length === 0) return 0;
      return atomic(() => {
        const update = db.prepare<[number, string, string, number, string, string, number]>(
          `UPDATE messages SET bulk = ?
           WHERE account_id = ? AND folder = ? AND uid = ? AND bulk IS NULL
             AND EXISTS (SELECT 1 FROM sync_state WHERE account_id = ? AND folder = ? AND uid_validity = ?)`,
        );
        let changed = 0;
        for (const mark of marks) {
          changed += update.run(mark.bulk ? 1 : 0, accountId, folder, mark.uid, accountId, folder, uidValidity).changes;
        }
        return changed;
      });
    },

    setDesired(messageIds, change) {
      return atomic(() => {
        const find = db.prepare<[string], { account_id: string; dedup_key: string }>(
          "SELECT account_id, dedup_key FROM messages WHERE id = ?",
        );
        const seen = change.seen === undefined ? null : change.seen ? 1 : 0;
        const flagged = change.flagged === undefined ? null : change.flagged ? 1 : 0;
        // Attached copies get the value to push (overwriting an opposite
        // one); other detached copies drop a pending value of a changed field
        // that differs from the request, so a stale intent cannot win when
        // they are reattached (NULL != x is not true, so NULL stays NULL).
        const update = db.prepare<
          [{ accountId: string; dedupKey: string; seen: number | null; flagged: number | null }],
          { thread_id: string }
        >(
          `UPDATE messages SET
             is_read = COALESCE(@seen, is_read),
             is_flagged = COALESCE(@flagged, is_flagged),
             seen_desired = CASE WHEN @seen IS NULL THEN seen_desired
               WHEN uid IS NOT NULL THEN @seen
               WHEN seen_desired != @seen THEN NULL ELSE seen_desired END,
             flag_desired = CASE WHEN @flagged IS NULL THEN flag_desired
               WHEN uid IS NOT NULL THEN @flagged
               WHEN flag_desired != @flagged THEN NULL ELSE flag_desired END
           WHERE account_id = @accountId AND dedup_key = @dedupKey
           RETURNING thread_id`,
        );
        // A named row keeps its intent even when detached: pushed after reattach.
        const named = db.prepare(
          `UPDATE messages SET seen_desired = COALESCE(@seen, seen_desired),
             flag_desired = COALESCE(@flagged, flag_desired)
           WHERE id = @id`,
        );
        const accounts: string[] = [];
        const done = new Set<string>();
        const touched = new Map<string, Set<string>>();
        for (const id of messageIds) {
          const row = find.get(id);
          if (!row) continue;
          if (!accounts.includes(row.account_id)) accounts.push(row.account_id);
          const key = `${row.account_id}\u0000${row.dedup_key}`;
          if (!done.has(key)) {
            done.add(key);
            const threads = touched.get(row.account_id) ?? new Set<string>();
            for (const copy of update.all({ accountId: row.account_id, dedupKey: row.dedup_key, seen, flagged })) {
              threads.add(copy.thread_id);
            }
            touched.set(row.account_id, threads);
          }
          named.run({ id, seen, flagged });
        }
        for (const [accountId, threadIds] of touched) refreshThreads(accountId, threadIds);
        return accounts.map((accountId) => ({ accountId }));
      });
    },

    pendingFlagIntents(accountId, folder) {
      return db
        .prepare<[string, string], { uid: number; seen_desired: number | null; flag_desired: number | null }>(
          `SELECT uid, seen_desired, flag_desired FROM messages
           WHERE account_id = ? AND folder = ? AND uid IS NOT NULL
             AND (seen_desired IS NOT NULL OR flag_desired IS NOT NULL)
           ORDER BY uid`,
        )
        .all(accountId, folder)
        .map((r) => ({
          uid: r.uid,
          seen: r.seen_desired === null ? null : r.seen_desired === 1,
          flagged: r.flag_desired === null ? null : r.flag_desired === 1,
        }));
    },

    clearFlagIntents(accountId, folder, pushed) {
      return atomic(() => {
        const clear = db.prepare(
          `UPDATE messages SET
             seen_desired = CASE WHEN seen_desired = @seen THEN NULL ELSE seen_desired END,
             flag_desired = CASE WHEN flag_desired = @flagged THEN NULL ELSE flag_desired END
           WHERE account_id = @accountId AND folder = @folder AND uid = @uid`,
        );
        const bit = (value: boolean | null) => (value === null ? null : value ? 1 : 0);
        // A null in `pushed` compares false in SQL, so that field is left alone.
        for (const intent of pushed) {
          clear.run({ accountId, folder, uid: intent.uid, seen: bit(intent.seen), flagged: bit(intent.flagged) });
        }
      });
    },

    markOpened(messageId) {
      return atomic(() => {
        const row = db
          .prepare<[string], { account_id: string; dedup_key: string }>(
            "SELECT account_id, dedup_key FROM messages WHERE id = ?",
          )
          .get(messageId);
        if (!row) return null;
        // Every unread copy is read: attached ones and the opened row itself
        // (even detached: pushed after reattach) get a read to push; other
        // detached copies are read locally only and drop a stale pending unread.
        const copies = db
          .prepare<[{ accountId: string; dedupKey: string; id: string }], { thread_id: string }>(
            `UPDATE messages SET is_read = 1,
               seen_desired = CASE WHEN uid IS NOT NULL OR id = @id THEN 1 ELSE NULL END
             WHERE account_id = @accountId AND dedup_key = @dedupKey AND is_read = 0
             RETURNING thread_id`,
          )
          .all({ accountId: row.account_id, dedupKey: row.dedup_key, id: messageId });
        refreshThreads(row.account_id, copies.map((c) => c.thread_id));
        return { accountId: row.account_id };
      });
    },

    // Threads --------------------------------------------------------------

    threadingInputs(accountId): ThreadingInput[] {
      return db
        .prepare<
          [string],
          {
            id: string;
            message_id: string | null;
            in_reply_to: string | null;
            refs: string;
            subject: string;
            date: string | null;
            gm_thrid: string | null;
          }
        >(
          `SELECT id, message_id, in_reply_to, refs, subject, date, gm_thrid
           FROM messages WHERE account_id = ? ORDER BY seq`,
        )
        .all(accountId)
        .map((r) => ({
          id: r.id,
          messageId: r.message_id,
          inReplyTo: r.in_reply_to,
          references: JSON.parse(r.refs) as string[],
          subject: r.subject,
          date: r.date,
          gmThreadId: r.gm_thrid,
        }));
    },

    assignThreads(accountId, threadOf) {
      if (sendersExcluded()) excludedStale = true;
      return atomic(() => {
        const ids = db
          .prepare<[string], { id: string }>("SELECT id FROM messages WHERE account_id = ?")
          .all(accountId);
        const update = db.prepare("UPDATE messages SET thread_id = ? WHERE id = ? AND thread_id != ?");
        for (const { id } of ids) {
          const threadId = threadOf.get(id) ?? `t_${id}`;
          update.run(threadId, id, threadId);
        }
        refreshThreads(accountId, null);
      });
    },

    listThreads(accountId, folder, cursor, limit, filter) {
      // Whole (account-wide) threads with a row in the folder that is not
      // waiting to move out. An uncorrelated IN list is built once from the
      // (account_id, folder, move_pending) index, so the cost stays linear;
      // the quick filters narrow that same list (spec resolution 20).
      return pageThreads({
        where: `account_id = @accountId AND threads.id IN (SELECT m.thread_id FROM messages m
          WHERE m.account_id = @accountId AND m.folder = @folder AND m.move_pending IS NULL${filterCondition(filter)})`,
        flagged: `EXISTS (SELECT 1 FROM messages f
          WHERE f.thread_id = threads.id AND f.account_id = @accountId AND f.folder = @folder
            AND f.move_pending IS NULL AND f.is_flagged = 1)`,
        snoozed: `(SELECT min(z.due_at) FROM messages s JOIN snoozes z ON z.message_id = s.id
          WHERE s.thread_id = threads.id AND s.account_id = @accountId AND s.folder = @folder)`,
        latest: `messages l WHERE l.thread_id = @threadId AND l.account_id = @accountId AND l.folder = @folder
          AND l.move_pending IS NULL`,
        params: { accountId, folder, ...filterParams(filter) },
        cursor,
        limit,
      });
    },

    listThreadsAll(role, cursor, limit, filter) {
      // Gmail's All Mail is never merged (server refuses the role too).
      if (role === "all") return { threads: [], nextCursor: null };
      // Thread ids are globally unique (threads.id is the primary key), so the
      // membership list needs no account match. The unary + keeps SQLite from
      // driving the query by the id autoindex: it scans threads_last_date in
      // (last_date DESC, id DESC) order without a temp B-tree.
      return pageThreads({
        where: `+threads.id IN (SELECT m.thread_id FROM ${MESSAGES_WITH_FOLDER}
          WHERE m.move_pending IS NULL AND ${ROW_ROLE} = @role${filterCondition(filter)})`,
        flagged: `EXISTS (SELECT 1 FROM ${MESSAGES_WITH_FOLDER}
          WHERE m.thread_id = threads.id AND m.move_pending IS NULL AND m.is_flagged = 1
            AND ${ROW_ROLE} = @role)`,
        snoozed: `(SELECT min(z.due_at) FROM ${MESSAGES_WITH_FOLDER} JOIN snoozes z ON z.message_id = m.id
          WHERE m.thread_id = threads.id AND ${ROW_ROLE} = @role)`,
        latest: `messages l LEFT JOIN folders lf ON lf.account_id = l.account_id AND lf.path = l.folder
          WHERE l.thread_id = @threadId AND l.move_pending IS NULL
            AND (CASE WHEN lf.special_use IS NOT NULL THEN lf.special_use WHEN upper(l.folder) = 'INBOX' THEN 'inbox' END) = @role`,
        params: { role, ...filterParams(filter) },
        cursor,
        limit,
      });
    },

    listRoles() {
      const rows = db
        .prepare<[], { role: SpecialUse; total: number; unread: number }>(
          `SELECT role, count(DISTINCT account_id || char(31) || dedup_key) AS total,
             count(DISTINCT CASE WHEN is_read = 0 THEN account_id || char(31) || dedup_key END) AS unread
           FROM (SELECT m.account_id, m.dedup_key, m.is_read, ${ROW_ROLE} AS role
                 FROM ${MESSAGES_WITH_FOLDER} WHERE m.move_pending IS NULL)
           WHERE role IS NOT NULL GROUP BY role`,
        )
        .all();
      const byRole = new Map(rows.map((r) => [r.role, r]));
      return UNIFIED_ROLES.map(
        (role): RoleCount => ({
          role,
          unreadCount: byRole.get(role)?.unread ?? 0,
          totalCount: byRole.get(role)?.total ?? 0,
        }),
      );
    },

    rawRef(messageId): RawRef | null {
      const row = db
        .prepare<
          [string],
          {
            account_id: string;
            folder: string;
            uid: number | null;
            size: number;
            message_id: string | null;
            move_pending: string | null;
            uid_validity: number | null;
          }
        >(
          `SELECT m.account_id, m.folder, m.uid, m.size, m.message_id, m.move_pending, s.uid_validity
           FROM messages m LEFT JOIN sync_state s ON s.account_id = m.account_id AND s.folder = m.folder
           WHERE m.id = ?`,
        )
        .get(messageId);
      if (!row || row.uid === null || row.move_pending !== null) return null;
      return {
        accountId: row.account_id,
        folder: row.folder,
        uid: row.uid,
        size: row.size,
        messageId: row.message_id,
        uidValidity: row.uid_validity,
      };
    },

    /**
     * Each message once: of the rows sharing a dedup key, prefer the copy in
     * the viewed folder unless it is waiting to move, then a copy not waiting
     * to move, the Inbox copy, a copy outside All Mail, the most recently
     * stored row.
     */
    getThread(threadId, folder): ThreadDetail | null {
      const thread = threadById.get(threadId);
      if (!thread) return null;
      const messages = db
        .prepare<[{ threadId: string; folder: string }], HeaderRow>(
          `SELECT * FROM (
             SELECT ${SUMMARY_COLUMNS}, m.to_json, m.cc_json, m.uid,
               row_number() OVER (PARTITION BY m.dedup_key
                 ORDER BY (m.folder = @folder AND m.move_pending IS NULL) DESC,
                   m.move_pending IS NULL DESC, ${IN_INBOX} DESC, ${IN_ALL_MAIL} ASC,
                   m.seq DESC) AS rn
             FROM messages m WHERE m.thread_id = @threadId)
           WHERE rn = 1 ORDER BY date IS NULL, date, id`,
        )
        .all({ threadId, folder })
        .map(header);
      const flagged =
        db
          .prepare<[{ threadId: string; folder: string }], { one: number }>(
            `SELECT 1 AS one FROM messages WHERE thread_id = @threadId AND folder = @folder
               AND move_pending IS NULL AND is_flagged = 1 LIMIT 1`,
          )
          .get({ threadId, folder }) !== undefined;
      const snoozed =
        db
          .prepare<[{ threadId: string; folder: string }], { due: string | null }>(
            `SELECT min(z.due_at) AS due FROM messages m JOIN snoozes z ON z.message_id = m.id
             WHERE m.thread_id = @threadId AND m.folder = @folder`,
          )
          .get({ threadId, folder })?.due ?? null;
      return { thread: toThread(thread, flagged, snoozed), messages, project: null, projectSuggestion: null };
    },

    getMessage(messageId) {
      const row = db
        .prepare<[string], HeaderRow>(
          `SELECT ${SUMMARY_COLUMNS}, m.to_json, m.cc_json, m.uid FROM messages m WHERE m.id = ?`,
        )
        .get(messageId);
      return row ? header(row) : null;
    },

    getBody(messageId): MessageBody | null {
      const row = db
        .prepare<
          [string],
          {
            id: string;
            body_text: string | null;
            body_html: string | null;
            html_truncated: number;
            images_allowed: number;
          }
        >(
          `SELECT m.id, m.body_text, m.body_html, m.html_truncated,
             EXISTS (SELECT 1 FROM image_senders i
               WHERE i.account_id = m.account_id AND i.address = mail_lower(m.from_address)) AS images_allowed
           FROM messages m WHERE m.id = ?`,
        )
        .get(messageId);
      return row
        ? {
            messageId: row.id,
            text: row.body_text,
            html: row.body_html,
            htmlTruncated: row.html_truncated === 1,
            remoteImagesAllowed: row.images_allowed === 1,
            codeBlocks: [],
          }
        : null;
    },

    search(query: ParsedQuery, accountId, limit, opts) {
      if (opts?.scoped === true) freshScope();
      const where: string[] = [];
      const params: unknown[] = [];
      let from = "FROM messages m";

      // Control characters make MATCH throw and never occur in indexed text.
      const text = query.text.replace(/[\u0000-\u001f\u007f]/g, "").trim();
      if (Array.from(text).length >= FTS_MIN_CHARS) {
        from = "FROM messages_fts JOIN messages m ON m.seq = messages_fts.rowid";
        where.push("messages_fts MATCH ?");
        params.push(ftsPhrase(text));
      } else if (text !== "") {
        const pattern = likePattern(text);
        where.push(
          "(mail_lower(m.subject) LIKE mail_lower(?) ESCAPE '\\' OR mail_lower(m.from_name) LIKE mail_lower(?) ESCAPE '\\' OR mail_lower(m.from_address) LIKE mail_lower(?) ESCAPE '\\')",
        );
        params.push(pattern, pattern, pattern);
      }
      if (accountId !== null) {
        where.push("m.account_id = ?");
        params.push(accountId);
      }
      if (query.from) {
        const pattern = likePattern(query.from);
        where.push(
          "(mail_lower(m.from_address) LIKE mail_lower(?) ESCAPE '\\' OR mail_lower(m.from_name) LIKE mail_lower(?) ESCAPE '\\')",
        );
        params.push(pattern, pattern);
      }
      if (query.subject) {
        where.push("mail_lower(m.subject) LIKE mail_lower(?) ESCAPE '\\'");
        params.push(likePattern(query.subject));
      }
      if (query.unread !== undefined) {
        where.push(query.unread ? "m.is_read = 0" : "m.is_read = 1");
      }
      const after = normalizeDate(query.after);
      if (after !== null) {
        where.push("m.date >= ?");
        params.push(after);
      }
      const before = normalizeDate(query.before);
      if (before !== null) {
        where.push("m.date < ?");
        params.push(before);
      }
      // A row waiting to move out is hidden until the move completes.
      where.push("m.move_pending IS NULL");
      // Agent paths: rows outside the AI scope go before the dedup picks a copy.
      if (opts?.scoped === true) where.push(IN_AI_SCOPE);
      params.push(limit);

      // One hit per message (dedup key): the Inbox copy, else the newest row.
      const sql = `SELECT * FROM (
          SELECT ${SUMMARY_COLUMNS},
            row_number() OVER (PARTITION BY m.account_id, m.dedup_key
              ORDER BY ${IN_INBOX} DESC, m.seq DESC) AS rn
          ${from}
          WHERE ${where.join(" AND ")})
        WHERE rn = 1
        ORDER BY date IS NULL DESC, date DESC, id DESC
        LIMIT ?`;
      return (db.prepare(sql).all(...params) as MessageRow[]).map(toSummary);
    },

    repairSnippets() {
      const scan = db.prepare<[number, number], { seq: number; snippet: string }>(
        "SELECT seq, snippet FROM messages WHERE seq > ? ORDER BY seq LIMIT ?",
      );
      const load = db.prepare<
        [number],
        {
          account_id: string;
          thread_id: string;
          snippet: string;
          body_text: string | null;
          body_html: string | null;
        }
      >("SELECT account_id, thread_id, snippet, body_text, body_html FROM messages WHERE seq = ?");
      const update = db.prepare("UPDATE messages SET snippet = ? WHERE seq = ?");
      let after = 0;
      let repaired = 0;
      for (;;) {
        const page = scan.all(after, SNIPPET_REPAIR_BATCH);
        if (page.length === 0) break;
        after = page[page.length - 1]!.seq;
        const stale = page.filter((row) => needsSnippetRepair(row.snippet));
        if (stale.length === 0) continue;
        repaired += atomic(() => {
          const touched = new Map<string, Set<string>>();
          let changed = 0;
          for (const { seq } of stale) {
            const row = load.get(seq);
            if (!row) continue;
            const next =
              row.body_text === null && row.body_html === null
                ? cleanSnippet(row.snippet)
                : snippetOf(row.body_text, row.body_html);
            if (next === row.snippet) continue;
            update.run(next, seq);
            changed++;
            const threads = touched.get(row.account_id) ?? new Set<string>();
            threads.add(row.thread_id);
            touched.set(row.account_id, threads);
          }
          for (const [accountId, threadIds] of touched) refreshThreads(accountId, threadIds);
          return changed;
        });
      }
      return repaired;
    },

    unreadCount(accountId) {
      const unread = `SELECT DISTINCT m.account_id, m.dedup_key FROM messages m
        WHERE m.is_read = 0 AND m.move_pending IS NULL AND ${IN_INBOX}`;
      const row =
        accountId === null
          ? db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM (${unread})`).get()
          : db
              .prepare<[string], { n: number }>(
                `SELECT count(*) AS n FROM (${unread} AND m.account_id = ?)`,
              )
              .get(accountId);
      return row?.n ?? 0;
    },

    // Folders ----------------------------------------------------------------

    saveFolders(accountId, folders: RemoteFolder[]) {
      return atomic(() => {
        const listed = new Set(folders.map((f) => f.path));
        const upsert = db.prepare(
          `INSERT INTO folders (account_id, path, name, delimiter, special_use, selectable)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, path) DO UPDATE SET name = excluded.name,
             delimiter = excluded.delimiter, special_use = excluded.special_use,
             selectable = excluded.selectable`,
        );
        for (const f of folders) {
          upsert.run(accountId, f.path, f.name, f.delimiter, f.specialUse, f.selectable ? 1 : 0);
        }
        const removed = db
          .prepare<[string], { path: string }>(
            "SELECT path FROM folders WHERE account_id = ? ORDER BY path",
          )
          .all(accountId)
          .map((r) => r.path)
          .filter((path) => !listed.has(path));
        const touched = new Set<string>();
        for (const path of removed) {
          const rows = db
            .prepare<[string, string], { id: string; thread_id: string }>(
              "SELECT id, thread_id FROM messages WHERE account_id = ? AND folder = ?",
            )
            .all(accountId, path);
          for (const threadId of deleteRows(rows)) touched.add(threadId);
          db.prepare("DELETE FROM sync_state WHERE account_id = ? AND folder = ?").run(accountId, path);
          db.prepare("DELETE FROM folders WHERE account_id = ? AND path = ?").run(accountId, path);
        }
        refreshThreads(accountId, touched);
        return { removed };
      });
    },

    listFolders(accountId): Folder[] {
      const rows = db
        .prepare<
          [string, string],
          {
            path: string;
            name: string;
            special_use: SpecialUse | null;
            selectable: number;
            total: number | null;
            unread: number | null;
          }
        >(
          `SELECT f.path, f.name, f.special_use, f.selectable, c.total, c.unread
           FROM folders f LEFT JOIN (
             SELECT folder, count(DISTINCT dedup_key) AS total,
               count(DISTINCT CASE WHEN is_read = 0 THEN dedup_key END) AS unread
             FROM messages WHERE account_id = ? AND move_pending IS NULL GROUP BY folder
           ) c ON c.folder = f.path
           WHERE f.account_id = ?`,
        )
        .all(accountId, accountId);
      return rows
        .map((r) => ({
          accountId,
          path: r.path,
          name: r.name,
          specialUse: effectiveSpecialUse(r.path, r.special_use),
          selectable: r.selectable === 1,
          unreadCount: r.unread ?? 0,
          totalCount: r.total ?? 0,
        }))
        .sort(compareFolders);
    },

    // Moves ------------------------------------------------------------------

    pendingMoves(accountId, folder) {
      return db
        .prepare<[string, string], { uid: number; id: string; destination: string }>(
          `SELECT uid, id, move_pending AS destination FROM messages
           WHERE account_id = ? AND folder = ? AND uid IS NOT NULL AND move_pending IS NOT NULL
           ORDER BY uid`,
        )
        .all(accountId, folder);
    },

    queueMove(messageIds, destination) {
      return atomic(() => {
        const ids = [...new Set(messageIds)];
        if (ids.length === 0) return null;
        const find = db.prepare<
          [string],
          { id: string; account_id: string; folder: string; move_pending: string | null }
        >("SELECT id, account_id, folder, move_pending FROM messages WHERE id = ?");
        const rows = ids.map((id) => find.get(id));
        const first = rows[0];
        if (!first) return null;
        const valid = rows.every(
          (r) =>
            r !== undefined &&
            r.account_id === first.account_id &&
            r.folder === first.folder &&
            r.move_pending === null,
        );
        if (!valid || first.folder === destination) return null;
        const queue = db.prepare(
          "UPDATE messages SET move_pending = ?, move_failures = 0 WHERE id = ?",
        );
        for (const id of ids) queue.run(destination, id);
        return { accountId: first.account_id, folder: first.folder };
      });
    },

    completeMove(accountId, folder, destination, moved, uids) {
      return atomic(() => {
        const find = db.prepare<
          [string, string, number, string],
          { id: string; thread_id: string; dedup_key: string }
        >(
          `SELECT id, thread_id, dedup_key FROM messages
           WHERE account_id = ? AND folder = ? AND uid = ? AND move_pending = ?`,
        );
        type Occupant = {
          id: string;
          thread_id: string;
          uid: number;
          seen_desired: number | null;
          flag_desired: number | null;
          move_pending: string | null;
        };
        const atUid = db.prepare<[string, string, number], Occupant>(
          `SELECT id, thread_id, uid, seen_desired, flag_desired, move_pending FROM messages
           WHERE account_id = ? AND folder = ? AND uid = ?`,
        );
        const sameMessage = db.prepare<[string, string, string, string], Occupant>(
          `SELECT id, thread_id, uid, seen_desired, flag_desired, move_pending FROM messages
           WHERE account_id = ? AND folder = ? AND dedup_key = ? AND uid IS NOT NULL
             AND move_pending IS NULL AND id != ?
           ORDER BY seq LIMIT 1`,
        );
        // Desired values: the moved row's own wins, else the occupant's
        // (non-NULL wins); local flags follow the resulting desired values.
        const rehome = db.prepare<
          [{ destination: string; uid: number | null; carriedSeen: number | null; carriedFlag: number | null; id: string }]
        >(
          `UPDATE messages SET folder = @destination, uid = @uid, move_pending = NULL,
             move_failures = 0,
             seen_desired = COALESCE(seen_desired, @carriedSeen),
             flag_desired = COALESCE(flag_desired, @carriedFlag),
             is_read = COALESCE(seen_desired, @carriedSeen, is_read),
             is_flagged = COALESCE(flag_desired, @carriedFlag, is_flagged)
           WHERE id = @id`,
        );
        const nothing = { carriedSeen: null, carriedFlag: null };
        const junk = folderRole(accountId, destination) === "junk";
        const settle = db.prepare(
          "UPDATE messages SET move_pending = NULL, move_failures = 0 WHERE id = ?",
        );
        const touched = new Set<string>();
        /**
         * The destination already holds this message (synced before the move
         * completed): the moved row keeps its id and takes that copy's uid,
         * carrying its pending desired values. An occupant that is itself waiting to move
         * is left alone and the moved row is detached instead.
         */
        const takeOver = (row: { id: string }, occupant: Occupant | undefined, uid: number | null) => {
          if (junk) markSpamSeen.run(row.id);
          if (occupant === undefined || occupant.id === row.id) {
            rehome.run({ destination, uid, ...nothing, id: row.id });
          } else if (occupant.move_pending !== null) {
            rehome.run({ destination, uid: null, ...nothing, id: row.id });
          } else {
            for (const threadId of deleteRows([occupant])) touched.add(threadId);
            rehome.run({
              destination,
              uid: occupant.uid,
              carriedSeen: occupant.seen_desired,
              carriedFlag: occupant.flag_desired,
              id: row.id,
            });
          }
        };
        for (const uid of uids) {
          const row = find.get(accountId, folder, uid, destination);
          if (!row) continue;
          touched.add(row.thread_id);
          if (moved === null) {
            // No uid map: merge into a destination copy of the same message
            // when there is one, else wait detached for the folder's sync.
            const copy = row.dedup_key.startsWith("id:")
              ? undefined
              : sameMessage.get(accountId, destination, row.dedup_key, row.id);
            takeOver(row, copy, null);
            continue;
          }
          const newUid = moved.get(uid);
          if (newUid === undefined) {
            // Gone from the source already: done; reconcile removes the row.
            settle.run(row.id);
            continue;
          }
          takeOver(row, atUid.get(accountId, destination, newUid), newUid);
        }
        refreshThreads(accountId, touched);
      });
    },

    failMove(accountId, folder, uids) {
      return atomic(() => {
        const bump = db.prepare<[string, string, number], { id: string; move_failures: number }>(
          `UPDATE messages SET move_failures = move_failures + 1
           WHERE account_id = ? AND folder = ? AND uid = ? AND move_pending IS NOT NULL
           RETURNING id, move_failures`,
        );
        const cancel = db.prepare(
          "UPDATE messages SET move_pending = NULL, move_failures = 0 WHERE id = ?",
        );
        const cancelled: string[] = [];
        for (const uid of uids) {
          const row = bump.get(accountId, folder, uid);
          if (row && row.move_failures >= MOVE_MAX_FAILURES) {
            cancel.run(row.id);
            cancelled.push(row.id);
          }
        }
        return { cancelled };
      });
    },

    // Images -----------------------------------------------------------------

    inlineParts(messageId): InlinePart[] {
      return db
        .prepare<[string], { content_id: string; mime_type: string; data: Buffer }>(
          "SELECT content_id, mime_type, data FROM inline_parts WHERE message_id = ? ORDER BY rowid",
        )
        .all(messageId)
        .map((r) => ({
          contentId: r.content_id,
          mimeType: r.mime_type,
          data: new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength),
        }));
    },

    isImageSenderAllowed(accountId, address) {
      return (
        db
          .prepare("SELECT 1 FROM image_senders WHERE account_id = ? AND address = ?")
          .get(accountId, address.toLowerCase()) !== undefined
      );
    },

    allowImageSender(accountId, address) {
      db.prepare(
        "INSERT OR IGNORE INTO image_senders (account_id, address, created_at) VALUES (?, ?, ?)",
      ).run(accountId, address.toLowerCase(), new Date().toISOString());
    },

    disallowImageSender(accountId, address) {
      return (
        db
          .prepare("DELETE FROM image_senders WHERE account_id = ? AND address = ?")
          .run(accountId, address.toLowerCase()).changes > 0
      );
    },

    // Compose and send (slice 3b) --------------------------------------------

    createDraft(input) {
      // One INSERT with origin and proposal_id: a hidden draft is never visible as an ordinary one.
      const copy = input.serverCopy;
      db.prepare(
        `INSERT INTO compose_drafts (id, account_id, kind, source_message_id, message_id, in_reply_to,
           refs_json, to_json, cc_json, bcc_json, subject, doc_json, import_json, revision, server_state,
           server_folder, server_uidvalidity, server_uid, server_revision, server_size, origin,
           proposal_id, from_address, purpose, created_at, updated_at)
         VALUES (@id, @accountId, @kind, @sourceMessageId, @messageId, @inReplyTo, @refs, @to, @cc, @bcc,
           @subject, @doc, @importHtml, 1, @serverState, @folder, @uidValidity, @uid, @serverRevision,
           @size, @origin, @proposalId, @fromAddress, @purpose, @createdAt, @createdAt)`,
      ).run({
        id: input.id,
        accountId: input.accountId,
        kind: input.kind,
        sourceMessageId: input.sourceMessageId,
        messageId: input.messageId,
        inReplyTo: input.inReplyTo,
        refs: JSON.stringify(input.references),
        to: JSON.stringify(input.to),
        cc: JSON.stringify(input.cc),
        bcc: JSON.stringify(input.bcc),
        subject: input.subject,
        doc: JSON.stringify(input.doc),
        importHtml: input.importHtml === null ? null : JSON.stringify(input.importHtml),
        serverState: copy === null ? "none" : "saved",
        folder: copy?.folder ?? null,
        uidValidity: copy?.uidValidity ?? null,
        uid: copy?.uid ?? null,
        serverRevision: copy?.revision ?? null,
        size: copy?.size ?? null,
        origin: input.origin,
        proposalId: input.proposalId,
        fromAddress: input.fromAddress,
        purpose: input.purpose ?? null,
        createdAt: input.createdAt,
      });
      return toDraft(draftById.get(input.id)!);
    },

    getDraft(id) {
      const row = draftById.get(id);
      return row ? toDraft(row) : null;
    },

    saveDraft(id, baseRevision, fields, updatedAt) {
      return atomic(() => {
        const current = draftById.get(id);
        if (!current) throw new Error("Draft not found");
        const changed = db
          .prepare(
            `UPDATE compose_drafts SET account_id = @accountId, to_json = @to, cc_json = @cc,
               bcc_json = @bcc, subject = @subject, doc_json = @doc, import_json = NULL,
               from_address = @fromAddress, revision = revision + 1, updated_at = @updatedAt
             WHERE id = @id AND revision = @baseRevision
               AND NOT EXISTS (SELECT 1 FROM outbox WHERE draft_id = @id)`,
          )
          .run({
            id,
            baseRevision,
            accountId: fields.accountId,
            to: JSON.stringify(fields.to),
            cc: JSON.stringify(fields.cc),
            bcc: JSON.stringify(fields.bcc),
            subject: fields.subject,
            doc: JSON.stringify(fields.doc),
            fromAddress: fields.fromAddress,
            updatedAt,
          }).changes;
        const revision = draftById.get(id)!.revision;
        return changed === 1 ? { revision } : { conflict: true as const, revision };
      });
    },

    saveImport(id, baseRevision, doc) {
      return atomic(() => {
        const current = draftById.get(id);
        if (!current) throw new Error("Draft not found");
        const changed = db
          .prepare(
            `UPDATE compose_drafts SET doc_json = @doc, import_json = NULL
             WHERE id = @id AND revision = @baseRevision AND import_json IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM outbox WHERE draft_id = @id)`,
          )
          .run({ id, baseRevision, doc: JSON.stringify(doc) }).changes;
        const revision = draftById.get(id)!.revision;
        return changed === 1 ? { revision } : { conflict: true as const, revision };
      });
    },

    deleteDraft(id) {
      atomic(() => deleteDraftRows(id));
    },

    listDrafts(accountId) {
      return db
        .prepare<[string], DraftRow>(
          "SELECT * FROM compose_drafts WHERE account_id = ? ORDER BY created_at, id",
        )
        .all(accountId)
        .map(toDraft);
    },

    draftForServerCopy(accountId, folder, uid) {
      return draftByServerCopy.get(accountId, folder, uid)?.id ?? null;
    },

    draftContinuing(sourceMessageId) {
      return draftContinuing.get(sourceMessageId)?.id ?? null;
    },

    renewMessageId(id, messageId) {
      db.prepare("UPDATE compose_drafts SET message_id = ? WHERE id = ?").run(messageId, id);
    },

    recordServerCopy(id, copy) {
      db.prepare(
        `UPDATE compose_drafts SET server_state = @state, server_folder = @folder,
           server_uidvalidity = @uidValidity, server_uid = @uid, server_revision = @revision,
           server_size = @size
         WHERE id = @id`,
      ).run({
        id,
        state: copy === null ? "none" : "saved",
        folder: copy?.folder ?? null,
        uidValidity: copy?.uidValidity ?? null,
        uid: copy?.uid ?? null,
        revision: copy?.revision ?? null,
        size: copy?.size ?? null,
      });
    },

    setServerCopyState(id, state) {
      db.prepare("UPDATE compose_drafts SET server_state = ? WHERE id = ?").run(state, id);
    },

    addAttachment(draftId, input): ComposeAttachment {
      return atomic(() => {
        if (!draftById.get(draftId)) throw new Error("Draft not found");
        const id = newAttachmentId();
        db.prepare(
          `INSERT INTO compose_attachments (id, draft_id, file_name, mime_type, size, sha256, content_id,
             data, position)
           VALUES (@id, @draftId, @fileName, @mimeType, @size, @sha256, @contentId, @data,
             (SELECT COALESCE(MAX(position), -1) + 1 FROM compose_attachments WHERE draft_id = @draftId))`,
        ).run({
          id,
          draftId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          size: input.size,
          sha256: input.sha256,
          contentId: input.contentId ?? null,
          data: Buffer.from(input.data),
        });
        return { id, fileName: input.fileName, mimeType: input.mimeType, size: input.size, origin: null };
      });
    },

    listAttachments(draftId) {
      return db
        .prepare<[string], { id: string; file_name: string; mime_type: string; size: number }>(
          `SELECT id, file_name, mime_type, size FROM compose_attachments WHERE draft_id = ?
           ORDER BY position`,
        )
        .all(draftId)
        .map((row) => ({ id: row.id, fileName: row.file_name, mimeType: row.mime_type, size: row.size, origin: null }));
    },

    attachmentData(draftId) {
      return db
        .prepare<[string], ComposeAttachmentRow>(
          `SELECT id, file_name, mime_type, size, sha256, content_id, data FROM compose_attachments
           WHERE draft_id = ? ORDER BY position`,
        )
        .all(draftId)
        .map((row) => ({
          id: row.id,
          fileName: row.file_name,
          mimeType: row.mime_type,
          size: row.size,
          sha256: row.sha256,
          contentId: row.content_id,
          data: bytesOf(row.data),
          origin: null,
        }));
    },

    removeAttachment(draftId, attachmentId) {
      return (
        db
          .prepare("DELETE FROM compose_attachments WHERE draft_id = ? AND id = ?")
          .run(draftId, attachmentId).changes > 0
      );
    },

    queueOutbox(input, draftBaseRevision) {
      return atomic(() => {
        const existing = outboxById.get(input.id);
        if (existing) return { row: toOutbox(existing), created: false };
        if (input.draftId !== null) {
          const draft = draftById.get(input.draftId);
          if (!draft || draft.revision !== draftBaseRevision || draftHeld.get(input.draftId)) {
            return { conflict: true as const };
          }
        }
        db.prepare(
          `INSERT INTO outbox (id, account_id, draft_id, message_id, subject, envelope_from,
             envelope_to_json, mime, bcc_header, state, send_after, attempts, error_kind, rejected_json,
             origin, created_at, updated_at)
           VALUES (@id, @accountId, @draftId, @messageId, @subject, @envelopeFrom, @envelopeTo, @mime,
             @bccHeader, 'queued', @sendAfter, 0, NULL, '[]', @origin, @createdAt, @createdAt)`,
        ).run({
          id: input.id,
          accountId: input.accountId,
          draftId: input.draftId,
          messageId: input.messageId,
          subject: input.subject,
          envelopeFrom: input.envelopeFrom,
          envelopeTo: JSON.stringify(input.envelopeTo),
          mime: Buffer.from(input.mime),
          bccHeader: input.bccHeader,
          sendAfter: isoOf(input.sendAfter),
          origin: input.origin,
          createdAt: isoOf(input.createdAt),
        });
        return { row: toOutbox(outboxById.get(input.id)!), created: true };
      });
    },

    getOutbox(id) {
      const row = outboxById.get(id);
      return row ? toOutbox(row) : null;
    },

    listOutbox(accountId) {
      const rows =
        accountId === null
          ? db.prepare<[], OutboxRow>(`SELECT ${OUTBOX_COLUMNS} FROM outbox ORDER BY created_at, id`).all()
          : db
              .prepare<[string], OutboxRow>(
                `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE account_id = ? ORDER BY created_at, id`,
              )
              .all(accountId);
      return rows.map(toOutbox);
    },

    outboxPayload(id) {
      const row = db
        .prepare<[string], { mime: Buffer; bcc_header: string | null }>(
          "SELECT mime, bcc_header FROM outbox WHERE id = ?",
        )
        .get(id);
      return row ? { mime: bytesOf(row.mime), bccHeader: row.bcc_header } : null;
    },

    transitionOutbox(id, from, to, patch = {}) {
      const sets = ["state = @to"];
      const params: Record<string, unknown> = { id, to, from: JSON.stringify(from) };
      if (patch.errorKind !== undefined) {
        sets.push("error_kind = @errorKind");
        params.errorKind = patch.errorKind;
      }
      if (patch.rejected !== undefined) {
        sets.push("rejected_json = @rejected");
        params.rejected = JSON.stringify(patch.rejected);
      }
      if (patch.sendAfter !== undefined) {
        sets.push("send_after = @sendAfter");
        params.sendAfter = isoOf(patch.sendAfter);
      }
      if (patch.countAttempt) sets.push("attempts = attempts + 1");
      if (patch.updatedAt !== undefined) {
        sets.push("updated_at = @updatedAt");
        params.updatedAt = isoOf(patch.updatedAt);
      }
      return atomic(() => {
        const changed =
          db
            .prepare(
              `UPDATE outbox SET ${sets.join(", ")}
               WHERE id = @id AND state IN (SELECT value FROM json_each(@from))`,
            )
            .run(params).changes === 1;
        if (changed && to === "sent") {
          // sent_recipients: every accepted envelope recipient, in the same transaction (slice 3d).
          const row = db
            .prepare<[string], { account_id: string; envelope_to_json: string; rejected_json: string; updated_at: string }>(
              "SELECT account_id, envelope_to_json, rejected_json, updated_at FROM outbox WHERE id = ?",
            )
            .get(id)!;
          const refused = new Set((JSON.parse(row.rejected_json) as string[]).map((a) => a.trim().toLowerCase()));
          const insert = db.prepare(
            `INSERT INTO sent_recipients (account_id, address, last_sent_at) VALUES (?, ?, ?)
             ON CONFLICT(account_id, address) DO UPDATE SET last_sent_at = excluded.last_sent_at`,
          );
          for (const address of new Set((JSON.parse(row.envelope_to_json) as string[]).map((a) => a.trim().toLowerCase()))) {
            if (address !== "" && !refused.has(address)) insert.run(row.account_id, address, row.updated_at);
          }
        }
        return changed;
      });
    },

    deleteOutbox(id, from) {
      return (
        db
          .prepare("DELETE FROM outbox WHERE id = ? AND state IN (SELECT value FROM json_each(?))")
          .run(id, JSON.stringify(from)).changes === 1
      );
    },

    nextDueOutbox(nowIso, busyAccounts) {
      const due = dueOutboxId(isoOf(nowIso), busyAccounts);
      return due === null ? null : toOutbox(outboxById.get(due)!);
    },

    claimDueOutbox(nowIso, busyAccounts, onlyId) {
      return atomic(() => {
        const now = isoOf(nowIso);
        const id = dueOutboxId(now, busyAccounts, onlyId);
        if (id === null) return null;
        const due = { id };
        const changed = db
          .prepare(
            `UPDATE outbox SET state = 'sending', attempts = attempts + 1, updated_at = ?
             WHERE id = ? AND state = 'queued'`,
          )
          .run(now, due.id).changes;
        return changed === 1 ? toOutbox(outboxById.get(due.id)!) : null;
      });
    },

    recoverOutboxOnStart(nowIso) {
      return atomic(() => {
        const now = isoOf(nowIso);
        const unknown = db
          .prepare(
            `UPDATE outbox SET state = 'unknown', error_kind = 'unknown_after_data', updated_at = ?
             WHERE state = 'sending'`,
          )
          .run(now).changes;
        const held = db
          .prepare(
            "UPDATE outbox SET state = 'held', updated_at = ? WHERE state = 'queued' AND send_after <= ?",
          )
          .run(now, now).changes;
        db.prepare("UPDATE outbox SET state = 'sent', updated_at = ? WHERE state = 'appending'").run(now);
        return { unknown, held };
      });
    },

    completeOutbox(id) {
      atomic(() => {
        const row = outboxById.get(id);
        if (!row) return;
        db.prepare("DELETE FROM outbox WHERE id = ?").run(id);
        if (row.draft_id !== null) deleteDraftRows(row.draft_id);
      });
      // The host creates the database with incremental auto_vacuum; give the
      // MIME and attachment pages back (a no-op otherwise, and skipped inside
      // a caller's transaction).
      if (!db.inTransaction) db.exec("PRAGMA incremental_vacuum");
    },

    hasSendingOutbox(accountId) {
      return (
        db
          .prepare<[string], { one: number }>(
            `SELECT 1 AS one FROM outbox WHERE account_id = ? AND state IN ('sending', 'appending') LIMIT 1`,
          )
          .get(accountId) !== undefined
      );
    },

    replySource(messageId) {
      const row = db
        .prepare<
          [string],
          {
            account_id: string;
            folder: string;
            from_name: string | null;
            from_address: string;
            to_json: string;
            cc_json: string;
            reply_to_json: string | null;
            subject: string;
            date: string | null;
            message_id: string | null;
            in_reply_to: string | null;
            refs: string | null;
          }
        >(
          `SELECT account_id, folder, from_name, from_address, to_json, cc_json, reply_to_json, subject,
             date, message_id, in_reply_to, refs FROM messages WHERE id = ?`,
        )
        .get(messageId);
      if (!row) return null;
      return {
        accountId: row.account_id,
        folder: row.folder,
        from: { name: row.from_name, address: row.from_address },
        to: JSON.parse(row.to_json) as MailAddress[],
        cc: JSON.parse(row.cc_json) as MailAddress[],
        replyTo: row.reply_to_json === null ? [] : (JSON.parse(row.reply_to_json) as MailAddress[]),
        replyToKnown: row.reply_to_json !== null,
        subject: row.subject,
        date: row.date,
        messageId: row.message_id,
        inReplyTo: row.in_reply_to,
        references: row.refs === null ? [] : (JSON.parse(row.refs) as string[]),
      };
    },

    recipientSuggestions(prefix, limit) {
      const pattern = likePattern(prefix.trim().toLowerCase());
      const rows = db
        .prepare<
          [{ pattern: string; scan: number }],
          {
            from_name: string | null;
            from_address: string;
            to_json: string;
            cc_json: string;
            date: string | null;
            role: string | null;
          }
        >(
          `SELECT m.from_name, m.from_address, m.to_json, m.cc_json, m.date, ${ROW_ROLE} AS role
           FROM ${MESSAGES_WITH_FOLDER}
           WHERE mail_lower(m.from_address) LIKE @pattern ESCAPE '\\'
              OR mail_lower(m.from_name) LIKE @pattern ESCAPE '\\'
              OR mail_lower(m.to_json) LIKE @pattern ESCAPE '\\'
              OR mail_lower(m.cc_json) LIKE @pattern ESCAPE '\\'
           ORDER BY m.date IS NULL, m.date DESC, m.seq DESC LIMIT @scan`,
        )
        .all({ pattern, scan: SUGGESTION_SCAN });
      const entries: SuggestionEntry[] = [];
      for (const row of rows) {
        entries.push({ address: row.from_address, name: row.from_name, date: row.date, ownerSent: false });
        const sent = row.role === "sent";
        for (const a of [
          ...(JSON.parse(row.to_json) as MailAddress[]),
          ...(JSON.parse(row.cc_json) as MailAddress[]),
        ]) {
          entries.push({ address: a.address, name: a.name, date: row.date, ownerSent: sent });
        }
      }
      return rankRecipientSuggestions(entries, prefix, limit);
    },

    // Agent proposals and translation (slice 3c) ------------------------------

    createProposal(input, admit) {
      return atomic(() => {
        admit?.(proposalCapRows(input.createdAt));
        db.prepare(
          `INSERT INTO agent_proposals (id, thread_id, draft_id, account_id, kind, source_message_id,
             added_json, content_sha256, left_out, view_token_sha256, viewed_at, state, outbox_id,
             template_name, expires_at, created_at, updated_at)
           VALUES (@id, @threadId, @draftId, @accountId, @kind, @sourceMessageId, @added, @contentSha256,
             @leftOut, NULL, NULL, 'pending', NULL, @templateName, @expiresAt, @createdAt, @createdAt)`,
        ).run({
          id: input.id,
          threadId: input.threadId,
          draftId: input.draftId,
          accountId: input.accountId,
          kind: input.kind,
          sourceMessageId: input.sourceMessageId,
          added: JSON.stringify(input.added),
          contentSha256: input.contentSha256,
          leftOut: input.leftOut,
          templateName: input.templateName,
          expiresAt: input.expiresAt,
          createdAt: input.createdAt,
        });
        return toProposal(proposalById.get(input.id)!);
      });
    },

    getProposal(id) {
      const row = proposalById.get(id);
      return row ? toProposal(row) : null;
    },

    proposalCapRows(nowIso) {
      return proposalCapRows(nowIso);
    },

    transitionProposal(id, from, to, updatedAt, patch = {}) {
      const sets = ["state = @to", "updated_at = @updatedAt"];
      if (patch.outboxId !== undefined) sets.push("outbox_id = @outboxId");
      if (patch.viewTokenSha256 !== undefined) sets.push("view_token_sha256 = @viewTokenSha256");
      if (patch.viewedAt !== undefined) sets.push("viewed_at = @viewedAt");
      return (
        db
          .prepare(
            `UPDATE agent_proposals SET ${sets.join(", ")}
             WHERE id = @id AND state IN (SELECT value FROM json_each(@from))`,
          )
          .run({
            id,
            to,
            updatedAt,
            from: JSON.stringify(from),
            outboxId: patch.outboxId ?? null,
            viewTokenSha256: patch.viewTokenSha256 ?? null,
            viewedAt: patch.viewedAt ?? null,
          }).changes === 1
      );
    },

    setViewToken(id, sha256, viewedAtIso) {
      return (
        db
          .prepare(
            `UPDATE agent_proposals SET view_token_sha256 = ?, viewed_at = ?
             WHERE id = ? AND state = 'pending'`,
          )
          .run(sha256, viewedAtIso, id).changes === 1
      );
    },

    releaseProposalDraft(id, draftId, updatedAt) {
      return atomic(() => {
        const moved = db
          .prepare(
            `UPDATE agent_proposals SET state = 'opened', updated_at = ?
             WHERE id = ? AND draft_id = ? AND state IN ('pending', 'confirming')
               AND EXISTS (SELECT 1 FROM compose_drafts WHERE id = ? AND proposal_id = ?)`,
          )
          .run(updatedAt, id, draftId, draftId, id).changes;
        if (moved !== 1) return false;
        db.prepare("UPDATE compose_drafts SET proposal_id = NULL WHERE id = ? AND proposal_id = ?").run(draftId, id);
        return true;
      });
    },

    undoAgentSend(outboxId, from, updatedAt) {
      return atomic(() => {
        const row = outboxById.get(outboxId);
        if (!row) return { cancelled: false, draftId: null };
        const deleted = db
          .prepare("DELETE FROM outbox WHERE id = ? AND state IN (SELECT value FROM json_each(?))")
          .run(outboxId, JSON.stringify(from)).changes;
        if (deleted !== 1) return { cancelled: false, draftId: row.draft_id };
        if (row.draft_id !== null) {
          db.prepare("UPDATE compose_drafts SET proposal_id = NULL WHERE id = ? AND proposal_id = ?").run(
            row.draft_id,
            outboxId,
          );
        }
        db.prepare(
          "UPDATE agent_proposals SET state = 'opened', updated_at = ? WHERE id = ? AND state = 'queued'",
        ).run(updatedAt, outboxId);
        return { cancelled: true, draftId: row.draft_id };
      });
    },

    dropProposalDraft(id) {
      atomic(() => dropHiddenDraft(id));
    },

    recoverProposalsOnStart(nowIso) {
      return atomic(() => {
        const queued = db
          .prepare(
            `UPDATE agent_proposals SET state = 'queued', outbox_id = id, updated_at = ?
             WHERE state = 'confirming' AND EXISTS (SELECT 1 FROM outbox WHERE outbox.id = agent_proposals.id)`,
          )
          .run(nowIso).changes;
        const doomed = db
          .prepare<[], { id: string }>("SELECT id FROM agent_proposals WHERE state IN ('pending', 'confirming')")
          .all();
        for (const { id } of doomed) {
          db.prepare("UPDATE agent_proposals SET state = 'expired', updated_at = ? WHERE id = ?").run(nowIso, id);
          dropHiddenDraft(id);
        }
        return { expired: doomed.length, queued };
      });
    },

    purgeProposals(beforeIso) {
      return db
        .prepare(
          "DELETE FROM agent_proposals WHERE state NOT IN ('pending', 'confirming') AND updated_at < ?",
        )
        .run(beforeIso).changes;
    },

    contacts(query, limit, opts) {
      const words = queryWords(query);
      if (words.length === 0 || limit <= 0) return [];
      const scoped = opts?.scoped === true;
      if (scoped) freshScope();
      // The topic mask runs over redacted text (messageTextMask), so a secret never finds a contact.
      const rows = db
        .prepare<[{ words: string; scan: number }], ContactRow>(
          `SELECT ${CONTACT_COLUMNS},
             mail_contact_mask(m.subject, m.snippet, substr(m.body_text, 1, ${CONTACT_BODY_CHARS}), @words) AS mask
           FROM ${MESSAGES_WITH_FOLDER}
           WHERE ${CONTACT_ROWS}${scoped ? ` AND ${IN_AI_SCOPE}` : ""}
           ORDER BY m.date IS NULL, m.date DESC, m.seq DESC LIMIT @scan`,
        )
        .all({ words: JSON.stringify(words), scan: CONTACT_SCAN });
      const bulkSenders = new Set(
        db
          .prepare<[], { address: string }>(
            "SELECT DISTINCT mail_lower(trim(from_address)) AS address FROM messages WHERE bulk = 1",
          )
          .all()
          .map((row) => row.address),
      );
      const ranked = rankContacts(rows.map(toContactMessage), words, ownerAccounts(), bulkSenders, scoped ? Infinity : limit);
      return scoped ? ranked.filter((c) => !senderExcluded([c.address], aiScope)).slice(0, limit) : ranked;
    },

    correspondence(addresses) {
      const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()))].filter((a) => a !== "");
      if (wanted.length === 0) return [];
      const inWanted = (column: string) =>
        `EXISTS (SELECT 1 FROM json_each(${column}) j
           WHERE mail_lower(trim(json_extract(j.value, '$.address'))) IN (SELECT value FROM json_each(@wanted)))`;
      const rows = db
        .prepare<[{ wanted: string }], ContactRow>(
          `SELECT ${CONTACT_COLUMNS}, 0 AS mask
           FROM ${MESSAGES_WITH_FOLDER}
           WHERE ${CONTACT_ROWS}
             AND (mail_lower(trim(m.from_address)) IN (SELECT value FROM json_each(@wanted))
               OR ${inWanted("m.to_json")} OR ${inWanted("m.cc_json")})`,
        )
        .all({ wanted: JSON.stringify(wanted) });
      return correspondenceOf(rows.map(toContactMessage), wanted, ownerAccounts());
    },

    addressesSentTo(addresses) {
      const wanted = new Set(addresses.map((a) => a.trim().toLowerCase()));
      const found = new Set<string>();
      if (wanted.size === 0) return found;
      const rows = db
        .prepare<[], { to_json: string; cc_json: string }>(
          `SELECT m.to_json, m.cc_json FROM ${MESSAGES_WITH_FOLDER} WHERE ${ROW_ROLE} = 'sent'`,
        )
        .iterate();
      for (const row of rows) {
        for (const a of [
          ...(JSON.parse(row.to_json) as MailAddress[]),
          ...(JSON.parse(row.cc_json) as MailAddress[]),
        ]) {
          const key = a.address.trim().toLowerCase();
          if (wanted.has(key)) found.add(key);
        }
      }
      const recorded = db
        .prepare<[string], { address: string }>(
          "SELECT DISTINCT address FROM sent_recipients WHERE address IN (SELECT value FROM json_each(?))",
        )
        .all(JSON.stringify([...wanted]));
      for (const row of recorded) found.add(row.address);
      return found;
    },

    sentToCount(address) {
      const wanted = address.trim().toLowerCase();
      if (wanted === "") return 0;
      const keys = new Set<string>();
      const rows = db
        .prepare<[], { account_id: string; dedup_key: string; to_json: string; cc_json: string }>(
          `SELECT m.account_id, m.dedup_key, m.to_json, m.cc_json FROM ${MESSAGES_WITH_FOLDER} WHERE ${ROW_ROLE} = 'sent'`,
        )
        .iterate();
      for (const row of rows) {
        const listed = [...(JSON.parse(row.to_json) as MailAddress[]), ...(JSON.parse(row.cc_json) as MailAddress[])];
        if (listed.some((a) => a.address.trim().toLowerCase() === wanted)) keys.add(`${row.account_id}\u0000${row.dedup_key}`);
      }
      return keys.size;
    },

    getTranslation(messageId, targetLanguage) {
      const row = db
        .prepare<[string, string], TranslationRow>(
          "SELECT * FROM translations WHERE message_id = ? AND target_language = ?",
        )
        .get(messageId, targetLanguage);
      return row ? toTranslation(row) : null;
    },

    putTranslation(row) {
      atomic(() => {
        db.prepare(
          `INSERT INTO translations (message_id, target_language, source_sha256, provider_id, model, text,
             truncated, created_at)
           VALUES (@messageId, @targetLanguage, @sourceSha256, @providerId, @model, @text, @truncated, @createdAt)
           ON CONFLICT(message_id, target_language) DO UPDATE SET source_sha256 = excluded.source_sha256,
             provider_id = excluded.provider_id, model = excluded.model, text = excluded.text,
             truncated = excluded.truncated, created_at = excluded.created_at`,
        ).run({ ...row, truncated: row.truncated ? 1 : 0 });
        db.prepare(
          `DELETE FROM translations WHERE rowid IN (
             SELECT rowid FROM translations
             ORDER BY created_at, message_id, target_language
             LIMIT max(0, (SELECT count(*) FROM translations) - ?))`,
        ).run(TRANSLATION_CACHE_ROWS);
      });
    },

    clearTranslations() {
      return db.prepare("DELETE FROM translations").run().changes;
    },

    // ---- Sending polish (slice 3d) ----

    listIdentities(accountId) {
      return db
        .prepare<[string | null, string | null], IdentityRow>(
          "SELECT * FROM identities WHERE ? IS NULL OR account_id = ? ORDER BY created_at, rowid",
        )
        .all(accountId, accountId)
        .map(toAlias);
    },

    upsertIdentity(input, nowIso) {
      return atomic(() => {
        const address = input.address.trim().toLowerCase();
        if (!accountById.get(input.accountId)) throw new ComposeError("not_found");
        const ownTaken = db
          .prepare<[string, string], { id: string }>(
            "SELECT id FROM accounts WHERE mail_lower(trim(email)) = ? OR mail_lower(trim(username)) = ? LIMIT 1",
          )
          .get(address, address);
        if (ownTaken) throw new ComposeError("conflict");
        const aliasTaken = db
          .prepare<[string, string], { id: string }>(
            "SELECT id FROM identities WHERE address = ? AND account_id <> ? AND state = 'active' LIMIT 1",
          )
          .get(address, input.accountId);
        if (aliasTaken) throw new ComposeError("conflict");
        const existing = db
          .prepare<[string, string], IdentityRow>("SELECT * FROM identities WHERE account_id = ? AND address = ?")
          .get(input.accountId, address);
        if (existing?.state !== "active") {
          const active = db
            .prepare<[string], { n: number }>("SELECT count(*) AS n FROM identities WHERE account_id = ? AND state = 'active'")
            .get(input.accountId)!.n;
          if (active >= IDENTITIES_MAX_PER_ACCOUNT) throw new ComposeError("conflict");
        }
        if (existing) {
          db.prepare("UPDATE identities SET state = 'active', display_name = ?, updated_at = ? WHERE id = ?").run(
            input.displayName,
            nowIso,
            existing.id,
          );
          return toAlias(db.prepare<[string], IdentityRow>("SELECT * FROM identities WHERE id = ?").get(existing.id)!);
        }
        const id = newIdentityId();
        db.prepare(
          `INSERT INTO identities (id, account_id, address, display_name, signature_json, state, send_check,
             check_message_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, 'active', 'unknown', NULL, ?, ?)`,
        ).run(id, input.accountId, address, input.displayName, nowIso, nowIso);
        return toAlias(db.prepare<[string], IdentityRow>("SELECT * FROM identities WHERE id = ?").get(id)!);
      });
    },

    updateIdentity(accountId, address, patch, nowIso) {
      return atomic(() => {
        const row = activeAlias.get(accountId, address.trim().toLowerCase());
        if (!row) return null;
        const displayName = patch.displayName !== undefined ? patch.displayName : row.display_name;
        const signature =
          patch.signature !== undefined ? (patch.signature === null ? null : JSON.stringify(patch.signature)) : row.signature_json;
        db.prepare("UPDATE identities SET display_name = ?, signature_json = ?, updated_at = ? WHERE id = ?").run(
          displayName,
          signature,
          nowIso,
          row.id,
        );
        return toAlias(db.prepare<[string], IdentityRow>("SELECT * FROM identities WHERE id = ?").get(row.id)!);
      });
    },

    setAccountSignature(accountId, signature) {
      return (
        db
          .prepare("UPDATE accounts SET signature_json = ? WHERE id = ?")
          .run(signature === null ? null : JSON.stringify(signature), accountId).changes === 1
      );
    },

    removeIdentity(accountId, address) {
      return (
        db
          .prepare("DELETE FROM identities WHERE account_id = ? AND address = ? AND state = 'active'")
          .run(accountId, address.trim().toLowerCase()).changes === 1
      );
    },

    dismissIdentity(accountId, address, nowIso) {
      db.prepare(
        `INSERT INTO identities (id, account_id, address, display_name, signature_json, state, send_check,
           check_message_id, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, 'dismissed', 'unknown', NULL, ?, ?)
         ON CONFLICT(account_id, address) DO NOTHING`,
      ).run(newIdentityId(), accountId, address.trim().toLowerCase(), nowIso, nowIso);
    },

    setSendCheck(accountId, address, check, checkMessageId, nowIso) {
      db.prepare(
        `UPDATE identities SET send_check = ?, check_message_id = ?, updated_at = ?
         WHERE account_id = ? AND address = ? AND state = 'active'`,
      ).run(check, checkMessageId, nowIso, accountId, address.trim().toLowerCase());
    },

    resolveSendChecks(accountId, nowIso) {
      return atomic(() => {
        const pending = db
          .prepare<[string], { id: string; address: string; check_message_id: string }>(
            `SELECT id, address, check_message_id FROM identities
             WHERE account_id = ? AND state = 'active' AND send_check = 'pending' AND check_message_id IS NOT NULL`,
          )
          .all(accountId);
        if (pending.length === 0) return 0;
        const findSent = db.prepare<[string, string, string], { from_address: string }>(
          `SELECT m.from_address FROM ${MESSAGES_WITH_FOLDER}
           WHERE m.account_id = ? AND ${ROW_ROLE} = 'sent' AND m.message_id IN (?, ?)
           ORDER BY m.seq LIMIT 1`,
        );
        const update = db.prepare("UPDATE identities SET send_check = ?, updated_at = ? WHERE id = ?");
        let changed = 0;
        for (const alias of pending) {
          const bare = normalizeMessageId(alias.check_message_id);
          const sent = findSent.get(accountId, bare, `<${bare}>`);
          const resolved = resolveSendCheck(alias.address, sent?.from_address ?? null);
          if (resolved === null) continue;
          update.run(resolved, nowIso, alias.id);
          changed++;
        }
        return changed;
      });
    },

    inboundAddressRows(accountId) {
      return db
        .prepare<[string], { to_json: string; cc_json: string; delivered_to_json: string | null; date: string | null }>(
          `SELECT m.to_json, m.cc_json, m.delivered_to_json, m.date FROM ${MESSAGES_WITH_FOLDER}
           WHERE m.account_id = ? AND m.bulk IS NOT 1
             AND COALESCE(${ROW_ROLE}, '') NOT IN ('sent', 'drafts', 'junk', 'trash')
           ORDER BY m.seq`,
        )
        .all(accountId)
        .map(
          (row): InboundRow => ({
            to: (JSON.parse(row.to_json) as MailAddress[]).map((a) => a.address),
            cc: (JSON.parse(row.cc_json) as MailAddress[]).map((a) => a.address),
            deliveredTo: row.delivered_to_json === null ? null : (JSON.parse(row.delivered_to_json) as string[]),
            date: row.date ?? "",
          }),
        );
    },

    conversationAddresses(messageId) {
      const source = db
        .prepare<[string], { account_id: string; thread_id: string }>("SELECT account_id, thread_id FROM messages WHERE id = ?")
        .get(messageId);
      if (!source) return null;
      const out = new Set<string>();
      const rows = db
        .prepare<[string, string], { from_address: string; to_json: string; cc_json: string; reply_to_json: string | null }>(
          "SELECT from_address, to_json, cc_json, reply_to_json FROM messages WHERE account_id = ? AND thread_id = ?",
        )
        .all(source.account_id, source.thread_id);
      for (const row of rows) {
        const addresses = [
          row.from_address,
          ...[row.to_json, row.cc_json, row.reply_to_json ?? "[]"].flatMap((json) => (JSON.parse(json) as MailAddress[]).map((a) => a.address)),
        ];
        for (const address of addresses) out.add(address.trim().toLowerCase());
      }
      return out;
    },

    deliveredToOf(messageId) {
      const row = db
        .prepare<[string], { delivered_to_json: string | null }>("SELECT delivered_to_json FROM messages WHERE id = ?")
        .get(messageId);
      return row?.delivered_to_json ? (JSON.parse(row.delivered_to_json) as string[]) : [];
    },

    undoRows(ids) {
      const wanted = [...new Set(ids)];
      if (wanted.length === 0) return [];
      return db
        .prepare<
          [string],
          { id: string; account_id: string; folder: string; uid: number | null; move_pending: string | null; is_read: number; is_flagged: number }
        >(
          `SELECT id, account_id, folder, uid, move_pending, is_read, is_flagged FROM messages
           WHERE id IN (SELECT value FROM json_each(?)) ORDER BY seq`,
        )
        .all(JSON.stringify(wanted))
        .map(
          (row): UndoRow => ({
            id: row.id,
            accountId: row.account_id,
            folder: row.folder,
            uid: row.uid,
            movePending: row.move_pending,
            isRead: row.is_read === 1,
            isFlagged: row.is_flagged === 1,
          }),
        );
    },

    cancelMove(ids, folder, destination) {
      return atomic(() => {
        const cleared: string[] = [];
        const clear = db.prepare(
          "UPDATE messages SET move_pending = NULL, move_failures = 0 WHERE id = ? AND folder = ? AND move_pending = ?",
        );
        for (const id of new Set(ids)) {
          if (clear.run(id, folder, destination).changes === 1) cleared.push(id);
        }
        return cleared;
      });
    },

    listTemplates() {
      return db.prepare<[], TemplateRow>("SELECT * FROM templates ORDER BY name_key, id").all().map(toTemplate);
    },

    saveTemplate(input, newId, nowIso) {
      return atomic(() => {
        const clash = db
          .prepare<[string, string | null], { id: string }>("SELECT id FROM templates WHERE name_key = ? AND id IS NOT ? LIMIT 1")
          .get(input.nameKey, input.id);
        if (clash) return { conflict: true as const };
        const existing =
          input.id === null ? undefined : db.prepare<[string], TemplateRow>("SELECT * FROM templates WHERE id = ?").get(input.id);
        const doc = JSON.stringify(input.doc);
        if (existing) {
          db.prepare("UPDATE templates SET name = ?, name_key = ?, doc_json = ?, updated_at = ? WHERE id = ?").run(
            input.name,
            input.nameKey,
            doc,
            nowIso,
            existing.id,
          );
          return { id: existing.id };
        }
        const total = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM templates").get()!.n;
        if (total >= TEMPLATES_MAX) throw new ComposeError("conflict", "There are too many templates");
        const id = input.id ?? newId;
        db.prepare(
          "INSERT INTO templates (id, name, name_key, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, input.name, input.nameKey, doc, nowIso, nowIso);
        return { id };
      });
    },

    deleteTemplate(id) {
      return db.prepare("DELETE FROM templates WHERE id = ?").run(id).changes === 1;
    },

    getTemplateByKey(nameKey) {
      const row = db.prepare<[string], TemplateRow>("SELECT * FROM templates WHERE name_key = ?").get(nameKey);
      return row ? toTemplate(row) : null;
    },

    // ---- Inbox triage (slice 3e) ----

    setSnoozeFolder(accountId, path) {
      db.prepare("UPDATE accounts SET snooze_folder = ? WHERE id = ?").run(path, accountId);
    },

    createSnoozes(rows, nowIso) {
      return atomic(() => {
        const ids = JSON.stringify(rows.map((row) => row.messageId));
        const live = db.prepare<[string, string], { n: number }>(
          `SELECT count(*) AS n FROM snoozes
           WHERE account_id = ? AND message_id NOT IN (SELECT value FROM json_each(?))`,
        );
        const adding = new Map<string, number>();
        for (const row of rows) adding.set(row.accountId, (adding.get(row.accountId) ?? 0) + 1);
        for (const [accountId, count] of adding) {
          if (live.get(accountId, ids)!.n + count > SNOOZES_MAX_PER_ACCOUNT) return { full: true as const };
        }
        const put = db.prepare(
          `INSERT INTO snoozes (message_id, account_id, return_to, due_at, state, created_at, updated_at)
           VALUES (@messageId, @accountId, @returnTo, @dueAt, @state, @now, @now)
           ON CONFLICT(message_id) DO UPDATE SET account_id = excluded.account_id,
             return_to = excluded.return_to, due_at = excluded.due_at, state = excluded.state,
             created_at = excluded.created_at, updated_at = excluded.updated_at`,
        );
        for (const row of rows) put.run({ ...row, dueAt: isoOf(row.dueAt), now: isoOf(nowIso) });
        return { created: rows.length };
      });
    },

    listSnoozes(accountId, opts) {
      return db
        .prepare<[{ accountId: string; dueBefore: string | null; limit: number }], SnoozeDbRow>(
          `SELECT * FROM snoozes WHERE account_id = @accountId
             AND (@dueBefore IS NULL OR due_at <= @dueBefore)
           ORDER BY due_at, message_id LIMIT @limit`,
        )
        .all({ accountId, dueBefore: opts.dueBefore === undefined ? null : isoOf(opts.dueBefore), limit: opts.limit })
        .map(toSnooze);
    },

    updateSnooze(messageId, patch, nowIso) {
      return (
        db
          .prepare(
            `UPDATE snoozes SET state = COALESCE(@state, state), due_at = COALESCE(@dueAt, due_at),
               return_to = COALESCE(@returnTo, return_to), updated_at = @now
             WHERE message_id = @messageId`,
          )
          .run({
            messageId,
            state: patch.state ?? null,
            dueAt: patch.dueAt === undefined ? null : isoOf(patch.dueAt),
            returnTo: patch.returnTo ?? null,
            now: isoOf(nowIso),
          }).changes === 1
      );
    },

    deleteSnoozes(messageIds) {
      if (messageIds.length === 0) return 0;
      return db
        .prepare("DELETE FROM snoozes WHERE message_id IN (SELECT value FROM json_each(?))")
        .run(JSON.stringify(messageIds)).changes;
    },

    snoozeViews(accountId, limit) {
      // In-flight rows first (they need a step whatever their due time), then
      // snoozed ones by due time.
      return db
        .prepare<
          [string, number],
          SnoozeDbRow & { folder: string | null; uid: number | null; move_pending: string | null; present: number | null }
        >(
          `SELECT z.*, m.folder, m.uid, m.move_pending, m.seq AS present
           FROM snoozes z LEFT JOIN messages m ON m.id = z.message_id
           WHERE z.account_id = ?
           ORDER BY z.state = 'snoozed', z.due_at, z.message_id LIMIT ?`,
        )
        .all(accountId, limit)
        .map((row) => ({
          snooze: toSnooze(row),
          row: row.present === null ? null : { folder: row.folder!, uid: row.uid, movePending: row.move_pending },
        }));
    },

    listBlockRules() {
      return db
        .prepare<[], BlockRuleDbRow>("SELECT * FROM block_rules ORDER BY created_at, id")
        .all()
        .map(toBlockRule);
    },

    addBlockRule(kind, value, id, nowIso) {
      return atomic(() => {
        const existing = db
          .prepare<[string, string], BlockRuleDbRow>("SELECT * FROM block_rules WHERE kind = ? AND value = ?")
          .get(kind, value);
        if (existing) return { rule: toBlockRule(existing), created: false };
        db.prepare("INSERT INTO block_rules (id, kind, value, created_at) VALUES (?, ?, ?, ?)").run(
          id,
          kind,
          value,
          isoOf(nowIso),
        );
        return { rule: { id, kind, value, createdAt: isoOf(nowIso) }, created: true };
      });
    },

    removeBlockRule(id) {
      return db.prepare("DELETE FROM block_rules WHERE id = ?").run(id).changes === 1;
    },

    blockMatches(rule) {
      const own = new Set(
        ownerAddressSets(store.listAccounts(), store.listIdentities(null)).flatMap((set) =>
          set.addresses.map((address) => address.trim().toLowerCase()),
        ),
      );
      // Inbox-role rows, attached and not moving, whose dedup key never
      // reached Spam (spam_seen, or a junk-role copy now).
      const rows = db
        .prepare<[], { id: string; account_id: string; folder: string; from_address: string }>(
          `SELECT m.id, m.account_id, m.folder, m.from_address FROM ${MESSAGES_WITH_FOLDER}
           WHERE m.uid IS NOT NULL AND m.move_pending IS NULL AND ${ROW_ROLE} = 'inbox'
             AND NOT EXISTS (SELECT 1 FROM spam_seen s WHERE s.account_id = m.account_id AND s.dedup_key = m.dedup_key)
             AND NOT EXISTS (SELECT 1 FROM messages j LEFT JOIN folders jf ON jf.account_id = j.account_id AND jf.path = j.folder
               WHERE j.account_id = m.account_id AND j.dedup_key = m.dedup_key AND jf.special_use = 'junk')
           ORDER BY m.seq`,
        )
        .all();
      return rows
        .filter((row) => !own.has(row.from_address.trim().toLowerCase()) && matchesBlock(row.from_address, [rule]) !== null)
        .map((row) => ({ id: row.id, accountId: row.account_id, folder: row.folder }));
    },

    spamSeen(accountId, dedupKeys) {
      if (dedupKeys.length === 0) return new Set();
      const found = db
        .prepare<[string, string, string, string], { key: string }>(
          `SELECT dedup_key AS key FROM spam_seen
             WHERE account_id = ? AND dedup_key IN (SELECT value FROM json_each(?))
           UNION
           SELECT m.dedup_key AS key FROM ${MESSAGES_WITH_FOLDER}
             WHERE m.account_id = ? AND m.dedup_key IN (SELECT value FROM json_each(?)) AND f.special_use = 'junk'`,
        )
        .all(accountId, JSON.stringify(dedupKeys), accountId, JSON.stringify(dedupKeys));
      return new Set(found.map((row) => row.key));
    },

    pruneSpamSeen(olderThanIso) {
      return db.prepare("DELETE FROM spam_seen WHERE seen_at < ?").run(isoOf(olderThanIso)).changes;
    },

    notifyRows(ids, nowIso) {
      if (ids.length === 0) return [];
      const rows = db
        .prepare<
          [string],
          {
            id: string;
            account_id: string;
            thread_id: string;
            role: SpecialUse | null;
            is_read: number;
            move_pending: string | null;
            uid: number | null;
            bulk: number | null;
            from_name: string | null;
            from_address: string;
            date: string | null;
            dedup_key: string;
          }
        >(
          `SELECT m.id, m.account_id, m.thread_id, ${ROW_ROLE} AS role, m.is_read, m.move_pending, m.uid,
             m.bulk, m.from_name, m.from_address, m.date, m.dedup_key
           FROM ${MESSAGES_WITH_FOLDER} WHERE m.id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(ids));
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.flatMap((id) => {
        const row = byId.get(id);
        if (!row) return [];
        return [
          {
            id: row.id,
            accountId: row.account_id,
            threadId: row.thread_id,
            folderRole: row.role,
            isRead: row.is_read === 1,
            movePending: row.move_pending,
            uid: row.uid,
            bulk: row.bulk === null ? null : row.bulk === 1,
            fromName: row.from_name,
            fromAddress: row.from_address,
            date: row.date,
            fetchedAt: isoOf(nowIso),
            dedupKey: row.dedup_key,
          },
        ];
      });
    },

    fillUnsubscribe(accountId, folder, uidValidity, values) {
      return atomic(() => {
        const state = db
          .prepare<[string, string], { uid_validity: number }>(
            "SELECT uid_validity FROM sync_state WHERE account_id = ? AND folder = ?",
          )
          .get(accountId, folder);
        if (state === undefined || state.uid_validity !== uidValidity) return 0;
        const fill = db.prepare(
          `UPDATE messages SET unsubscribe_json = ?
           WHERE account_id = ? AND folder = ? AND uid = ? AND unsubscribe_json IS NULL`,
        );
        let changed = 0;
        for (const value of values) {
          const json = unsubscribeJson(value.info);
          if (json === null) continue;
          changed += fill.run(json, accountId, folder, value.uid).changes;
        }
        return changed;
      });
    },

    unsubscribeUnknown(accountId, folder, belowUid, limit) {
      return db
        .prepare<
          [{ accountId: string; folder: string; below: number | null; limit: number }],
          { uid: number; from_name: string | null; from_address: string }
        >(
          `SELECT uid, from_name, from_address FROM messages
           WHERE account_id = @accountId AND folder = @folder AND uid IS NOT NULL AND bulk = 1
             AND unsubscribe_json IS NULL AND (@below IS NULL OR uid < @below)
           ORDER BY uid DESC LIMIT @limit`,
        )
        .all({ accountId, folder, below: belowUid, limit })
        .map((row) => ({ uid: row.uid, from: { name: row.from_name, address: row.from_address } }));
    },

    inboxMessages(accountId, opts) {
      const where = [IN_INBOX, "m.uid IS NOT NULL", "m.move_pending IS NULL"];
      const params: unknown[] = [];
      if (accountId !== null) {
        where.push("m.account_id = ?");
        params.push(accountId);
      }
      if (opts.unreadOnly) where.push("m.is_read = 0");
      if (opts.scoped === true) {
        freshScope();
        where.push(IN_AI_SCOPE_OR_ALL_MAIL);
      }
      params.push(opts.limit);
      const rows = db
        .prepare(
          `SELECT * FROM (
             SELECT ${SUMMARY_COLUMNS}, m.bulk, m.unsubscribe_json, s.due_at AS snoozed_until,
               row_number() OVER (PARTITION BY m.account_id, m.dedup_key ORDER BY m.seq DESC) AS rn
             FROM messages m LEFT JOIN snoozes s ON s.message_id = m.id
             WHERE ${where.join(" AND ")})
           WHERE rn = 1
           ORDER BY date IS NULL DESC, date DESC, id DESC
           LIMIT ?`,
        )
        .all(...params) as (MessageRow & { bulk: number | null; unsubscribe_json: string | null; snoozed_until: string | null })[];
      return rows.map((row) => ({
        ...toSummary(row),
        bulk: row.bulk === null ? null : row.bulk === 1,
        unsubscribe: row.unsubscribe_json ? (JSON.parse(row.unsubscribe_json) as UnsubscribeInfo) : null,
        snoozedUntil: row.snoozed_until,
      }));
    },

    getUnsubscribeInfo(messageId) {
      const row = db
        .prepare<[string], { unsubscribe_json: string | null }>("SELECT unsubscribe_json FROM messages WHERE id = ?")
        .get(messageId);
      return row?.unsubscribe_json ? (JSON.parse(row.unsubscribe_json) as UnsubscribeInfo) : null;
    },

    getUnsubscribe(accountId, listKey) {
      const row = db
        .prepare<[string, string], UnsubscribeDbRow>("SELECT * FROM unsubscribes WHERE account_id = ? AND list_key = ?")
        .get(accountId, listKey);
      return row ? toUnsubscribe(row) : null;
    },

    putUnsubscribe(row) {
      db.prepare(
        `INSERT INTO unsubscribes (account_id, list_key, method, state, outbox_id, requested_at)
         VALUES (@accountId, @listKey, @method, @state, @outboxId, @requestedAt)
         ON CONFLICT(account_id, list_key) DO UPDATE SET method = excluded.method, state = excluded.state,
           outbox_id = excluded.outbox_id, requested_at = excluded.requested_at`,
      ).run({ ...row, requestedAt: isoOf(row.requestedAt) });
    },

    setUnsubscribeStateByOutbox(outboxId, state) {
      return db.prepare("UPDATE unsubscribes SET state = ? WHERE outbox_id = ?").run(state, outboxId).changes > 0;
    },

    createTriageBatch(batch, items) {
      atomic(() => {
        db.prepare(
          `INSERT INTO triage_batches (id, thread_id, state, content_hash, summary, created_at, updated_at, expires_at)
           VALUES (@id, @threadId, 'pending', @contentHash, @summary, @createdAt, @createdAt, @expiresAt)`,
        ).run({ ...batch, createdAt: isoOf(batch.createdAt), expiresAt: isoOf(batch.expiresAt) });
        const put = db.prepare(
          `INSERT INTO triage_items (batch_id, position, message_id, account_id, action, snooze_until, note, outcome)
           VALUES (@batchId, @position, @messageId, @accountId, @action, @snoozeUntil, @note, @outcome)`,
        );
        for (const item of items) put.run({ ...item, batchId: batch.id });
      });
    },

    getTriageBatch(id) {
      const batch = db.prepare<[string], TriageBatchDbRow>("SELECT * FROM triage_batches WHERE id = ?").get(id);
      if (!batch) return null;
      const items = db
        .prepare<[string], TriageItemDbRow>("SELECT * FROM triage_items WHERE batch_id = ? ORDER BY position")
        .all(id)
        .map(toTriageItem);
      return { batch: toTriageBatch(batch), items };
    },

    transitionTriageBatch(id, from, to, patch, nowIso) {
      const sets = ["state = @to", "updated_at = @now"];
      if (patch.viewTokenHash !== undefined) sets.push("view_token_hash = @viewTokenHash");
      if (patch.approved !== undefined) sets.push("approved_json = @approved");
      if (patch.createSnoozeFolder !== undefined) sets.push("create_snooze_folder_json = @createSnoozeFolder");
      return (
        db
          .prepare(
            `UPDATE triage_batches SET ${sets.join(", ")}
             WHERE id = @id AND state IN (SELECT value FROM json_each(@from))`,
          )
          .run({
            id,
            from: JSON.stringify(from),
            to,
            now: isoOf(nowIso),
            viewTokenHash: patch.viewTokenHash ?? null,
            approved: patch.approved === undefined ? null : JSON.stringify(patch.approved),
            createSnoozeFolder: patch.createSnoozeFolder === undefined ? null : JSON.stringify(patch.createSnoozeFolder),
          }).changes === 1
      );
    },

    setTriageOutcomes(id, outcomes) {
      atomic(() => {
        const set = db.prepare("UPDATE triage_items SET outcome = ? WHERE batch_id = ? AND position = ?");
        for (const { position, outcome } of outcomes) set.run(outcome, id, position);
      });
    },

    triageHistory(sinceIso) {
      return db
        .prepare<[string], { thread_id: string; state: TriageBatchState; created_at: string; updated_at: string }>(
          `SELECT thread_id, state, created_at, updated_at FROM triage_batches
           WHERE created_at >= ? OR state IN ('pending', 'confirming')`,
        )
        .all(isoOf(sinceIso))
        .map((row) => ({ threadId: row.thread_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at }));
    },

    settleTriageAtStart(nowIso) {
      return atomic(() => {
        const now = isoOf(nowIso);
        const interrupted = db
          .prepare("UPDATE triage_batches SET state = 'interrupted', updated_at = ? WHERE state = 'applying'")
          .run(now).changes;
        const expired = db
          .prepare(
            "UPDATE triage_batches SET state = 'expired', updated_at = ? WHERE state IN ('pending', 'confirming')",
          )
          .run(now).changes;
        return { interrupted, expired };
      });
    },

    cancelSendPurpose(outboxId, states) {
      return atomic(() => {
        const row = db
          .prepare<[string], { draft_id: string | null }>("SELECT draft_id FROM outbox WHERE id = ?")
          .get(outboxId);
        if (!row || row.draft_id === null) return { cancelled: false };
        const draft = draftById.get(row.draft_id);
        if (!draft || draft.purpose === null) return { cancelled: false };
        if (!store.deleteOutbox(outboxId, states)) return { cancelled: false };
        deleteDraftRows(draft.id);
        return { cancelled: true };
      });
    },

    // ---- Agent and mail (slice 3f) ----------------------------------------

    setAiScope(scope) {
      aiScope = scope;
      rebuildExcludedThreads();
    },

    getAiScope() {
      return aiScope;
    },

    loadAiScope() {
      const accounts = new Map<string, AccountScope>();
      const rows = db
        .prepare<[], { account_id: string; mode: string; folders_json: string | null }>(
          "SELECT account_id, mode, folders_json FROM ai_scope_accounts ORDER BY account_id",
        )
        .all();
      for (const row of rows) {
        if (row.mode === "none") accounts.set(row.account_id, { mode: "none" });
        else if (row.mode === "folders") {
          accounts.set(row.account_id, { mode: "folders", folders: JSON.parse(row.folders_json ?? "[]") as string[] });
        } else accounts.set(row.account_id, { mode: "all" });
      }
      const addresses = new Set<string>();
      const domains = new Set<string>();
      for (const row of db
        .prepare<[], { kind: string; value: string }>("SELECT kind, value FROM ai_scope_senders ORDER BY kind, value")
        .all()) {
        (row.kind === "domain" ? domains : addresses).add(row.value);
      }
      return { accounts, senders: { addresses, domains } };
    },

    putAiScope(accounts, senders, nowIso) {
      atomic(() => {
        db.prepare("DELETE FROM ai_scope_accounts").run();
        db.prepare("DELETE FROM ai_scope_senders").run();
        const putAccount = db.prepare(
          "INSERT OR REPLACE INTO ai_scope_accounts (account_id, mode, folders_json, updated_at) VALUES (?, ?, ?, ?)",
        );
        for (const { accountId, scope } of accounts) {
          putAccount.run(accountId, scope.mode, scope.mode === "folders" ? JSON.stringify(scope.folders) : null, nowIso);
        }
        const putSender = db.prepare("INSERT OR IGNORE INTO ai_scope_senders (kind, value, created_at) VALUES (?, ?, ?)");
        for (const sender of senders) putSender.run(sender.kind, sender.value, nowIso);
      });
    },

    refreshExcludedThreads() {
      rebuildExcludedThreads();
    },

    scopedMessage(messageId) {
      freshScope();
      const row = db
        .prepare<[{ id: string }], HeaderRow>(
          `SELECT ${SUMMARY_COLUMNS}, m.to_json, m.cc_json, m.uid
           FROM messages c JOIN messages m ON m.account_id = c.account_id AND m.dedup_key = c.dedup_key
           WHERE c.id = @id AND ${IN_AI_SCOPE}
           ORDER BY m.id = @id DESC, ${IN_INBOX} DESC, m.seq DESC LIMIT 1`,
        )
        .get({ id: messageId });
      return row ? header(row) : null;
    },

    appendAgentLog(entry) {
      const result = db
        .prepare(
          `INSERT INTO agent_log (at, actor, thread_id, tool, outcome, message_ids_json, result_count, hidden_count,
             ref_id, provider, model)
           VALUES (@at, @actor, @threadId, @tool, @outcome, @ids, @count, @hidden, @refId, @provider, @model)`,
        )
        .run({
          at: entry.at,
          actor: entry.actor,
          threadId: entry.threadId,
          tool: entry.tool,
          outcome: entry.outcome,
          ids: JSON.stringify(entry.messageIds.slice(0, AGENT_LOG_IDS_MAX)),
          count: entry.count,
          hidden: entry.hiddenCount,
          refId: entry.refId,
          provider: entry.provider,
          model: entry.model,
        });
      return Number(result.lastInsertRowid);
    },

    setAgentLogSources(seq, messageIds, count, hiddenCount) {
      return db
        .prepare("UPDATE agent_log SET message_ids_json = ?, result_count = ?, hidden_count = ? WHERE seq = ?")
        .run(JSON.stringify([...new Set(messageIds)].slice(0, AGENT_LOG_IDS_MAX)), count, hiddenCount, seq).changes;
    },

    updateAgentLog(refId, outcome, count) {
      return db.prepare("UPDATE agent_log SET outcome = ?, result_count = ? WHERE ref_id = ?").run(outcome, count, refId)
        .changes;
    },

    listAgentLog(opts) {
      const where: string[] = [];
      const params: Record<string, unknown> = { limit: opts.limit + 1 };
      if (opts.threadId !== undefined) {
        where.push("thread_id = @threadId");
        params.threadId = opts.threadId;
      }
      const after = opts.cursor == null ? null : Number(opts.cursor);
      if (after !== null && Number.isInteger(after)) {
        where.push("seq < @after");
        params.after = after;
      }
      const rows = db
        .prepare<[Record<string, unknown>], AgentLogRow>(
          `SELECT * FROM agent_log ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
           ORDER BY seq DESC LIMIT @limit`,
        )
        .all(params);
      const page = rows.slice(0, opts.limit).map(toLogEntry);
      const last = page[page.length - 1];
      return { entries: page, next: rows.length > opts.limit && last ? String(last.seq) : null };
    },

    clearAgentLog() {
      return db.prepare("DELETE FROM agent_log").run().changes;
    },

    purgeAgentLog(beforeIso, maxRows) {
      return atomic(() => {
        const old = db.prepare("DELETE FROM agent_log WHERE at < ?").run(beforeIso).changes;
        const over = db
          .prepare("DELETE FROM agent_log WHERE seq NOT IN (SELECT seq FROM agent_log ORDER BY seq DESC LIMIT ?)")
          .run(maxRows).changes;
        return old + over;
      });
    },

    getAiResult(kind, subjectId) {
      const row = db
        .prepare<[string, string], AiResultRow>("SELECT * FROM ai_results WHERE kind = ? AND subject_id = ?")
        .get(kind, subjectId);
      return row ? toAiResult(row) : null;
    },

    putAiResult(row) {
      if (Buffer.byteLength(row.resultJson, "utf8") > AI_RESULT_MAX_BYTES) throw new Error("AI result too large");
      db.prepare(
        `INSERT OR REPLACE INTO ai_results (kind, subject_id, account_id, source_sha256, provider, model,
           result_json, notes_json, created_at)
         VALUES (@kind, @subjectId, @accountId, @sourceSha256, @provider, @model, @resultJson, @notesJson, @createdAt)`,
      ).run(row);
    },

    keepTasks(rows) {
      return atomic(() => {
        const open = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM mail_tasks WHERE done_at IS NULL").get()!.n;
        if (open + rows.length > TASKS_OPEN_MAX) return { full: true as const };
        const insert = db.prepare(
          `INSERT INTO mail_tasks (id, account_id, message_id, dedup_key, title, due_date, done_at, created_at, updated_at)
           VALUES (@id, @accountId, @messageId, @dedupKey, @title, @due, NULL, @createdAt, @createdAt)`,
        );
        for (const row of rows) insert.run(row);
        return { kept: rows.length };
      });
    },

    listTasks(opts) {
      const offset = opts.cursor == null ? 0 : Math.max(0, Number(opts.cursor) || 0);
      const order = opts.done ? "t.done_at DESC, t.id DESC" : "t.due_date IS NULL, t.due_date, t.created_at, t.id";
      const rows = db
        .prepare<[number, number], TaskRow>(
          `SELECT t.*, m.thread_id FROM mail_tasks t LEFT JOIN messages m ON m.id = t.message_id
           WHERE t.done_at IS ${opts.done ? "NOT NULL" : "NULL"}
           ORDER BY ${order} LIMIT ? OFFSET ?`,
        )
        .all(opts.limit + 1, offset);
      const page = rows.slice(0, opts.limit).map(toTask);
      return { tasks: page, next: rows.length > opts.limit ? String(offset + opts.limit) : null };
    },

    getTask(id) {
      const row = db
        .prepare<[string], TaskRow>(
          "SELECT t.*, m.thread_id FROM mail_tasks t LEFT JOIN messages m ON m.id = t.message_id WHERE t.id = ?",
        )
        .get(id);
      return row ? toTask(row) : null;
    },

    updateTask(id, patch, nowIso) {
      const sets = ["updated_at = @now"];
      const params: Record<string, unknown> = { id, now: nowIso };
      if (patch.title !== undefined) {
        sets.push("title = @title");
        params.title = patch.title;
      }
      if (patch.due !== undefined) {
        sets.push("due_date = @due");
        params.due = patch.due;
      }
      if (patch.done !== undefined) sets.push(patch.done ? "done_at = COALESCE(done_at, @now)" : "done_at = NULL");
      return db.prepare(`UPDATE mail_tasks SET ${sets.join(", ")} WHERE id = @id`).run(params).changes > 0;
    },

    deleteTask(id) {
      return db.prepare("DELETE FROM mail_tasks WHERE id = ?").run(id).changes > 0;
    },

    taskCounts(today) {
      const row = db
        .prepare<[string, string], { overdue: number | null; today: number | null }>(
          `SELECT sum(due_date < ?) AS overdue, sum(due_date = ?) AS today
           FROM mail_tasks WHERE done_at IS NULL AND due_date IS NOT NULL`,
        )
        .get(today, today)!;
      return { overdue: row.overdue ?? 0, today: row.today ?? 0 };
    },

    setCategories(messageIds, category, source, nowIso) {
      return atomic(() => {
        const previous: PreviousLabel[] = [];
        const seen = new Set<string>();
        const keyOf = db.prepare<[string], { account_id: string; dedup_key: string }>(
          "SELECT account_id, dedup_key FROM messages WHERE id = ?",
        );
        const current = db.prepare<[string, string], { category: Category; source: CategorySource }>(
          "SELECT category, source FROM message_categories WHERE account_id = ? AND dedup_key = ?",
        );
        const put = db.prepare(
          `INSERT OR REPLACE INTO message_categories (account_id, dedup_key, category, source, set_at) VALUES (?, ?, ?, ?, ?)`,
        );
        const clear = db.prepare("DELETE FROM message_categories WHERE account_id = ? AND dedup_key = ?");
        for (const id of messageIds) {
          const key = keyOf.get(id);
          if (!key || seen.has(dismissalKey(key.account_id, key.dedup_key))) continue;
          seen.add(dismissalKey(key.account_id, key.dedup_key));
          const before = current.get(key.account_id, key.dedup_key);
          // A rule never overrides the owner's label.
          if (source === "rule" && before?.source === "owner") continue;
          previous.push({
            accountId: key.account_id,
            dedupKey: key.dedup_key,
            category: before?.category ?? null,
            source: before?.source ?? null,
          });
          if (category === null) clear.run(key.account_id, key.dedup_key);
          else put.run(key.account_id, key.dedup_key, category, source, nowIso);
        }
        return { previous };
      });
    },

    restoreCategories(previous, nowIso) {
      atomic(() => {
        const put = db.prepare(
          `INSERT OR REPLACE INTO message_categories (account_id, dedup_key, category, source, set_at) VALUES (?, ?, ?, ?, ?)`,
        );
        const clear = db.prepare("DELETE FROM message_categories WHERE account_id = ? AND dedup_key = ?");
        for (const label of previous) {
          if (label.category === null) clear.run(label.accountId, label.dedupKey);
          else put.run(label.accountId, label.dedupKey, label.category, label.source ?? "owner", nowIso);
        }
      });
    },

    categoriesOf(messageIds) {
      const out = new Map<string, { category: Category | null; source: CategorySource | null; suggestion: AiCategoryAnswer | null }>();
      if (messageIds.length === 0) return out;
      const rows = db
        .prepare<
          [string],
          { id: string; category: Category | null; source: CategorySource | null; suggestion: AiCategoryAnswer | null }
        >(
          `SELECT m.id, c.category, c.source, s.category AS suggestion
           FROM messages m
           LEFT JOIN message_categories c ON c.account_id = m.account_id AND c.dedup_key = m.dedup_key
           LEFT JOIN category_suggestions s ON s.account_id = m.account_id AND s.dedup_key = m.dedup_key
           WHERE m.id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(messageIds));
      for (const row of rows) out.set(row.id, { category: row.category, source: row.source, suggestion: row.suggestion });
      return out;
    },

    putCategorySuggestions(rows, nowIso) {
      atomic(() => {
        const put = db.prepare(
          `INSERT OR REPLACE INTO category_suggestions (account_id, dedup_key, category, created_at)
           SELECT account_id, dedup_key, ?, ? FROM messages WHERE id = ?`,
        );
        for (const row of rows) put.run(row.category, nowIso, row.messageId);
      });
    },

    listCategoryRules() {
      return db
        .prepare<[], CategoryRuleRow>("SELECT * FROM category_rules ORDER BY created_at, id")
        .all()
        .map(toCategoryRule);
    },

    addCategoryRule(kind, value, category, id, nowIso) {
      return atomic(() => {
        const existing = db
          .prepare<[string, string], CategoryRuleRow>("SELECT * FROM category_rules WHERE kind = ? AND value = ?")
          .get(kind, value);
        if (existing) return { rule: toCategoryRule(existing), created: false };
        const total = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM category_rules").get()!.n;
        if (total >= CATEGORY_RULES_MAX) return { full: true as const };
        db.prepare("INSERT INTO category_rules (id, kind, value, category, created_at) VALUES (?, ?, ?, ?, ?)").run(
          id,
          kind,
          value,
          category,
          nowIso,
        );
        return { rule: { id, kind, value, category, createdAt: nowIso }, created: true };
      });
    },

    removeCategoryRule(id) {
      return db.prepare("DELETE FROM category_rules WHERE id = ?").run(id).changes > 0;
    },

    replyCandidates(sinceIso, limit) {
      // The latest dated copy of each conversation (an Inbox copy first among
      // copies of the same date), with the newest Sent-role row of it.
      const rows = db
        .prepare<[{ since: string; limit: number }], ReplyCandidateRow>(
          `SELECT * FROM (
             SELECT m.thread_id, m.account_id, m.id, m.dedup_key, m.date, ${ROW_ROLE} AS role, m.from_address,
               m.to_json, m.cc_json, m.bulk,
               (SELECT max(sm.date) FROM messages sm LEFT JOIN folders sf ON sf.account_id = sm.account_id AND sf.path = sm.folder
                 WHERE sm.thread_id = m.thread_id AND sf.special_use = 'sent') AS last_sent,
               row_number() OVER (PARTITION BY m.thread_id
                 ORDER BY m.date DESC, ${IN_INBOX} DESC, m.seq DESC) AS rn
             FROM ${MESSAGES_WITH_FOLDER}
             WHERE m.move_pending IS NULL AND m.date IS NOT NULL
               AND m.thread_id IN (SELECT thread_id FROM messages WHERE date >= @since))
           WHERE rn = 1
           ORDER BY date DESC, id DESC
           LIMIT @limit`,
        )
        .all({ since: sinceIso, limit });
      return rows.map((row) => ({
        threadId: row.thread_id,
        accountId: row.account_id,
        messageId: row.id,
        dedupKey: row.dedup_key,
        date: row.date,
        folderRole: row.role,
        fromAddress: row.from_address,
        to: addressesOf(row.to_json),
        cc: addressesOf(row.cc_json),
        bulk: row.bulk === null ? null : row.bulk === 1,
        lastSentAt: row.last_sent,
      }));
    },

    replyDismissals() {
      return new Set(
        db
          .prepare<[], { account_id: string; dedup_key: string }>("SELECT account_id, dedup_key FROM reply_dismissals")
          .all()
          .map((row) => dismissalKey(row.account_id, row.dedup_key)),
      );
    },

    dismissReply(accountId, dedupKey, nowIso) {
      db.prepare(
        "INSERT OR REPLACE INTO reply_dismissals (account_id, dedup_key, dismissed_at) VALUES (?, ?, ?)",
      ).run(accountId, dedupKey, nowIso);
    },

    getDigest(day) {
      const row = db.prepare<[string], DigestRow>("SELECT * FROM digests WHERE day = ?").get(day);
      return row
        ? {
            day: row.day,
            builtAt: row.built_at,
            since: row.since,
            replyCount: row.reply_count,
            noticeCount: row.notice_count,
            notifiedAt: row.notified_at,
          }
        : null;
    },

    putDigest(row) {
      return (
        db
          .prepare(
            `INSERT OR IGNORE INTO digests (day, built_at, since, reply_count, notice_count, notified_at)
             VALUES (@day, @builtAt, @since, @replyCount, @noticeCount, @notifiedAt)`,
          )
          .run(row).changes > 0
      );
    },

    markDigestNotified(day, nowIso) {
      return db.prepare("UPDATE digests SET notified_at = ? WHERE day = ? AND notified_at IS NULL").run(nowIso, day)
        .changes > 0;
    },

    createReminder(row) {
      return atomic(() => {
        const live = db
          .prepare<[], { n: number }>(
            // A queued reminder whose send failed is not live until a retry queues it again.
            `SELECT count(*) AS n FROM reply_reminders r WHERE r.state IN ('waiting', 'due')
               OR (r.state = 'queued' AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.id = r.outbox_id AND o.state = 'failed'))`,
          )
          .get()!.n;
        if (live >= REMINDERS_LIVE_MAX) return { full: true as const };
        db.prepare(
          `INSERT INTO reply_reminders (id, account_id, outbox_id, rfc_message_id, thread_id, days, sent_at, due_at,
             state, created_at, updated_at, notified_at)
           VALUES (@id, @accountId, @outboxId, @rfcMessageId, @threadId, @days, @sentAt, @dueAt, @state, @createdAt,
             @createdAt, NULL)`,
        ).run(row);
        return { created: true as const };
      });
    },

    bindReminder(outboxId, sentAtIso) {
      return atomic(() => {
        const row = db
          .prepare<[string], ReminderRow>("SELECT * FROM reply_reminders WHERE outbox_id = ? AND state = 'queued'")
          .get(outboxId);
        if (!row) return null;
        db.prepare(
          `UPDATE reply_reminders SET state = 'waiting', outbox_id = NULL, sent_at = ?, due_at = ?, updated_at = ?
           WHERE id = ?`,
        ).run(sentAtIso, dueAt(sentAtIso, row.days), sentAtIso, row.id);
        return toReminder(db.prepare<[string], ReminderRow>("SELECT * FROM reply_reminders WHERE id = ?").get(row.id)!);
      });
    },

    deleteReminderForOutbox(outboxId) {
      return db.prepare("DELETE FROM reply_reminders WHERE outbox_id = ?").run(outboxId).changes;
    },

    getReminder(id) {
      const row = db.prepare<[string], ReminderRow>("SELECT * FROM reply_reminders WHERE id = ?").get(id);
      return row ? toReminder(row) : null;
    },

    listReminders(opts) {
      if (opts.states.length === 0) return [];
      const params: Record<string, unknown> = { states: JSON.stringify(opts.states), limit: opts.limit };
      let due = "";
      if (opts.dueBefore !== undefined) {
        due = " AND due_at IS NOT NULL AND due_at <= @dueBefore";
        params.dueBefore = opts.dueBefore;
      }
      return db
        .prepare<[Record<string, unknown>], ReminderRow>(
          `SELECT * FROM reply_reminders WHERE state IN (SELECT value FROM json_each(@states))${due}
           ORDER BY due_at IS NULL, due_at, created_at, id LIMIT @limit`,
        )
        .all(params)
        .map(toReminder);
    },

    updateReminder(id, patch, nowIso) {
      const sets = ["updated_at = @now"];
      const params: Record<string, unknown> = { id, now: nowIso };
      const columns: [keyof typeof patch, string][] = [
        ["state", "state"],
        ["days", "days"],
        ["dueAt", "due_at"],
        ["threadId", "thread_id"],
        ["notifiedAt", "notified_at"],
      ];
      for (const [key, column] of columns) {
        if (patch[key] === undefined) continue;
        sets.push(`${column} = @${key}`);
        params[key] = patch[key];
      }
      return db.prepare(`UPDATE reply_reminders SET ${sets.join(", ")} WHERE id = @id`).run(params).changes > 0;
    },

    answeringRows(rfcMessageIds, afterIso) {
      const bare = [...new Set(rfcMessageIds.map(normalizeMessageId).filter((id) => id !== ""))];
      if (bare.length === 0) return [];
      const spellings = JSON.stringify([...bare, ...bare.map((id) => `<${id}>`)]);
      const rows = db
        .prepare<[{ ids: string; after: string }], AnsweringDbRow>(
          `SELECT m.id, m.account_id, m.thread_id, m.message_id, m.in_reply_to, m.refs, m.date, m.bulk, m.from_address
           FROM messages m
           WHERE m.date > @after
             AND (m.in_reply_to IN (SELECT value FROM json_each(@ids))
               OR EXISTS (SELECT 1 FROM json_each(m.refs) r WHERE r.value IN (SELECT value FROM json_each(@ids))))
           ORDER BY m.date, m.seq`,
        )
        .all({ ids: spellings, after: afterIso });
      return rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        threadId: row.thread_id,
        messageId: row.message_id,
        inReplyTo: row.in_reply_to,
        references: JSON.parse(row.refs) as string[],
        date: row.date,
        bulk: row.bulk === null ? null : row.bulk === 1,
        fromAddress: row.from_address,
      }));
    },

    sentCopyThread(accountId, rfcMessageId) {
      const bare = normalizeMessageId(rfcMessageId);
      if (bare === "") return null;
      return (
        db
          .prepare<[string, string, string], { thread_id: string }>(
            `SELECT thread_id FROM messages WHERE account_id = ? AND message_id IN (?, ?) ORDER BY seq DESC LIMIT 1`,
          )
          .get(accountId, bare, `<${bare}>`)?.thread_id ?? null
      );
    },

    purgeDaily(nowIso) {
      const now = Date.parse(nowIso);
      const before = (days: number) => new Date(now - days * 86_400_000).toISOString();
      return atomic(() => {
        let removed = 0;
        for (const table of ["message_categories", "category_suggestions"]) {
          removed += db
            .prepare(
              `DELETE FROM ${table} WHERE NOT EXISTS (SELECT 1 FROM messages m
                 WHERE m.account_id = ${table}.account_id AND m.dedup_key = ${table}.dedup_key)`,
            )
            .run().changes;
        }
        removed += db
          .prepare("DELETE FROM ai_results WHERE subject_id NOT IN (SELECT id FROM threads)")
          .run().changes;
        removed += db.prepare("DELETE FROM digests WHERE built_at < ?").run(before(DAY_ROWS_KEEP_DAYS)).changes;
        removed += db.prepare("DELETE FROM reply_dismissals WHERE dismissed_at < ?").run(before(DAY_ROWS_KEEP_DAYS)).changes;
        removed += db
          .prepare("DELETE FROM reply_reminders WHERE state IN ('answered', 'dismissed') AND updated_at < ?")
          .run(before(ANSWERED_KEEP_DAYS)).changes;
        removed += store.purgeAgentLog(before(AGENT_LOG_KEEP_DAYS), AGENT_LOG_ROWS_MAX);
        return removed;
      });
    },

    // ---- Slice 3g (stubs until migration element 11) ----
    setDevClass: notYet,
    devUnclassified: () => [],
    listUnknown: () => [],
    fillListIds: notYet,
    devGroups: () => ({ groups: [], next: null }),
    addBbLink: notYet,
    listBbLinks: () => [],
    pruneBbLinks: notYet,
    setConversationProject: notYet,
    conversationProject: () => null,
    addBinding: notYet,
    removeBinding: notYet,
    listBindings: () => [],
    projectThreads: () => ({ threads: [], nextCursor: null }),
    putIncident: notYet,
    incidentFor: () => null,
    touchIncident: notYet,
    listRules: () => [],
    saveRule: notYet,
    deleteRule: notYet,
    pauseRules: notYet,
    resumeRules: notYet,
    insertRuleRun: notYet,
    updateRuleRun: notYet,
    ruleRunByBbThread: () => null,
    getRuleRun: () => null,
    listRuleRuns: () => ({ runs: [], next: null }),
    failStaleStarts: notYet,
  };
  return store;
}

function notYet(): never {
  throw new Error("Not available yet");
}

