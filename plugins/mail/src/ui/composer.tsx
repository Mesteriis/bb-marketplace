// The composer: From, To/Cc/Bcc chips, Subject, the rich-text editor,
// attachments and the footer (Send, Discard, save state). It autosaves the
// draft (the document JSON only), sends it through the outbox with one
// request id per Send (reused when the call is retried), and on Escape
// either closes or asks Save draft · Discard · Keep editing. Every RPC is an
// injected port; nothing here knows the host.
import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import type { Account, ComposeAttachment, DraftView, IdentityView, MailAddress } from "../core/model.ts";
import type { PresendIssue } from "../core/presend.ts";
import { parseAddress } from "../core/compose-address.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  AttachButton,
  AttachmentChips,
  uploadFile,
  type PendingUpload,
  type UploadPort,
} from "./attachments-input.tsx";
import { ComposeEditor, ownerRange, insertParagraphs, replaceOwnerRange, type EditorDoc } from "./compose-editor.tsx";
import { NO_TYPING, takeSnippet, type SnippetList, type TypingOptions } from "./editor-typing.ts";
import { fillBlocks, fillVariables, firstNameOf, mergeRecipients } from "../core/snippets.ts";
import { introLine, looksLikeIntro, moveSenderToBcc } from "../core/intro.ts";
import { Checkbox } from "@/components/ui/checkbox";
import type { AiJobPorts } from "./ai-job.ts";
import { ImproveDialog, ImproveMenu, type DraftMode, type ImproveRequest } from "./improve-dialog.tsx";
import { WriteDialog, type WriteInput } from "./write-dialog.tsx";
import { browserDictation, useDictation, type DictationDeps } from "./dictation.ts";
import { dictatedParagraphs } from "../core/dictation-text.ts";
import { daysText } from "./reminder-strip.tsx";
import { ComposeToolbar } from "./compose-toolbar.tsx";
import { accountLabel } from "./folder-list.tsx";
import { chipText, MAX_CHIP_LENGTH, MIN_CHIP_LENGTH, RecipientInput, addChips, splitTyped } from "./recipient-input.tsx";
import { isMacPlatform, stopEscape } from "./shortcuts.ts";
import { sendCheckText, type TemplateView } from "./settings/shared.ts";
import { PresendDialog } from "./presend-dialog.tsx";
import { BbFilePicker, type FilePickRequest } from "./bb-file-picker.tsx";
import type { BbCall } from "./bb-ports.ts";
import { findSignature, signatureKey } from "./signature-node.ts";
import { TemplatesPopover } from "./templates-popover.tsx";
import { SendLaterMenu, type SmartSendTime } from "./send-later-menu.tsx";
import { msg, tx } from "./i18n/index.ts";

/** Typing rests this long before the draft is saved. */
export const AUTOSAVE_MS = 1_500;

export type ComposeWarningKind = "original_unavailable" | "attachments_left_out" | "original_kept" | null;

export interface ComposerSaveInput {
  draftId: string;
  baseRevision: number;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  doc: EditorDoc;
  saveToServer?: boolean;
  /** The editor's one-time load of the draft's import: not an edit. */
  imported?: boolean;
  /** The identity to send from: null = the account's own address; absent = unchanged (slice 3d). */
  fromAddress?: string | null;
}

export type ComposerSaveResult = { revision: number; originalKept?: true } | { conflict: true; revision: number };

/** The RPC surface the composer needs, injected by the host adapter. */
export interface ComposerPorts {
  save(input: ComposerSaveInput): Promise<ComposerSaveResult>;
  send(input: {
    draftId: string;
    baseRevision: number;
    requestId: string;
    remindAfterDays?: number;
    /** Slice 3k: sign or encrypt this message with OpenPGP. */
    protect?: { sign: boolean; encrypt: boolean };
    /** Slice 3l, "Send later": the time to send, UTC ISO. */
    sendAt?: string;
  }): Promise<{
    outboxId: string;
    sendAfter: string;
  }>;
  discard(draftId: string): Promise<void>;
  upload: UploadPort;
  removeAttachment(draftId: string, attachmentId: string): Promise<void>;
  suggest(prefix: string): Promise<MailAddress[]>;
  /** The draft as stored now (Reload after a conflict). */
  reload(draftId: string): Promise<DraftView>;
  /** compose_check: the advisory pre-send issues (slice 3d). Any failure sends anyway. */
  check?(input: { draftId: string; baseRevision: number }): Promise<{ issues: PresendIssue[] }>;
  /** Slice 3k: whether From has an OpenPGP key, and the recipients Mail has no key for. Absent: no OpenPGP row. */
  pgpCheck?(from: string, recipients: string[]): Promise<{ canSign: boolean; missing: string[] }>;
  /** Typing speed: attaches a template's files to the draft; `leftOut` names what the message has no room for. */
  applyTemplate?(input: { draftId: string; templateId: string }): Promise<{ attached: ComposeAttachment[]; leftOut: string[] }>;
  /** Smart send: the time the saved draft's first recipient usually writes; null from too little mail. Absent: not offered. */
  smartSend?(draftId: string): Promise<SmartSendTime | null>;
  /** Dictation: BB's voice service turns a recording into text. Absent: no microphone button. */
  transcribe?(audio: Blob, signal: AbortSignal): Promise<string>;
}

export interface ComposerProps {
  /** Typing speed: autocorrect and autocomplete as the settings have them; absent: none. */
  typing?: TypingOptions;
  /** Slice 3i: Apple Mail's Shift+Command+D sends; absent: read from the platform. */
  mac?: boolean;
  draft: DraftView;
  /** AI writes mail: a drafted reply the owner chose to use, put in as the owner's text once. */
  initialOwn?: readonly string[];
  /** Dictation: the microphone and recorder; absent: the browser's (tests inject fakes). */
  dictationDevice?: Pick<DictationDeps, "microphone" | "record">;
  accounts: readonly Account[];
  ports: ComposerPorts;
  /** From compose_prepare or compose_open. */
  warning?: ComposeWarningKind;
  /** Addresses of the original left out of the recipients. */
  dropped?: readonly string[];
  /** "panel": beside or under the conversation; "page": the whole page, with Back. */
  layout?: "panel" | "page";
  onClose: () => void;
  onSent: (outbox: { outboxId: string; sendAfter: string }) => void;
  onOpenSmtpSettings: (accountId: string) => void;
  /** Focus entered (true) or left (false) the composer. */
  onFocusWithin?: (focused: boolean) => void;
  /** A fresh request id per Send; tests inject one. */
  newRequestId?: () => string;
  /** Every account's sending identities (slice 3d); without them From lists the own addresses. */
  identities?: readonly IdentityView[];
  /** Templates for the toolbar picker; absent: no Templates button. */
  templates?: readonly TemplateView[];
  /** Manage templates… in the picker: opens Mail settings. */
  onManageTemplates?: () => void;
  /** Improve (slice 3f): the AI ports and why it is off; absent: no Improve. */
  improve?: { jobs: AiJobPorts; disabledReason: string | null };
  /** replyReminderDays (slice 3f): the Remind checkbox beside Send; absent: none. */
  reminderDays?: number;
  /** Attach from a BB project or thread (slice 3g); absent: not offered. */
  bbFiles?: { call: BbCall; projectId: string | null; threadId: string | null };
}

/** One entry of the From list: an identity of an account that can send. */
export interface FromChoice {
  key: string;
  accountId: string;
  address: string;
  primary: boolean;
  label: string;
  signature: EditorDoc | null;
  sendCheck: IdentityView["sendCheck"];
  /** The draft's address is not an active identity any more. */
  missing: boolean;
}

const fromKey = (accountId: string, address: string) => JSON.stringify([accountId, address.toLowerCase()]);

function identityLabel(displayName: string | null, address: string): string {
  return displayName !== null && displayName.trim() !== "" ? `${displayName.trim()} <${address}>` : address;
}

/**
 * The From list: every active identity of every account with SMTP (and of
 * the draft's account), own address first; an account with no identities
 * loaded offers its own address. The draft's address stays listed, marked,
 * when it is no longer set up.
 */
export function fromChoicesOf(
  accounts: readonly Account[],
  identities: readonly IdentityView[] | undefined,
  current: { accountId: string; address: string | null },
): FromChoice[] {
  const choices: FromChoice[] = [];
  for (const account of accounts) {
    if (!account.smtpConfigured && account.id !== current.accountId) continue;
    const own = (identities ?? [])
      .filter((identity) => identity.accountId === account.id)
      .sort((a, b) => Number(b.primary) - Number(a.primary));
    const list =
      own.length > 0
        ? own
        : [
            {
              accountId: account.id,
              address: account.email.toLowerCase(),
              displayName: account.displayName,
              primary: true,
              signature: null,
              sendCheck: "unknown" as const,
            },
          ];
    for (const identity of list) {
      choices.push({
        key: fromKey(account.id, identity.address),
        accountId: account.id,
        address: identity.address,
        primary: identity.primary,
        label: identityLabel(identity.displayName, identity.address),
        signature: (identity.signature as EditorDoc | null) ?? null,
        sendCheck: identity.sendCheck,
        missing: false,
      });
    }
    if (
      account.id === current.accountId &&
      current.address !== null &&
      !list.some((identity) => identity.address === current.address!.toLowerCase())
    ) {
      choices.push({
        key: fromKey(account.id, current.address),
        accountId: account.id,
        address: current.address.toLowerCase(),
        primary: false,
        label: current.address,
        signature: null,
        sendCheck: "unknown",
        missing: true,
      });
    }
  }
  return choices;
}

/** The choice the draft sends from now. */
function currentChoice(choices: readonly FromChoice[], from: { accountId: string; address: string | null }) {
  const ofAccount = choices.filter((c) => c.accountId === from.accountId);
  if (from.address === null) return ofAccount.find((c) => c.primary) ?? ofAccount[0] ?? null;
  return ofAccount.find((c) => c.address === from.address!.toLowerCase()) ?? null;
}

type Field = { chips: string[]; text: string };
type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "unsaved" }
  | { kind: "error"; text: string };
type Conflict = { revision: number; queued: boolean } | null;

const TITLES: Record<DraftView["kind"], string> = {
  new: msg("New message"),
  reply: msg("Reply"),
  reply_all: msg("Reply all"),
  forward: msg("Forward"),
};

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : tx("Something went wrong");
}

/** The start of the message a reply answers, as plain text: the draft's own text nodes, then the original's HTML without tags and styles. */
function introText(draft: DraftView): string {
  const words: string[] = [];
  const walk = (node: { text?: unknown; content?: unknown }) => {
    if (typeof node.text === "string") words.push(node.text);
    if (Array.isArray(node.content)) for (const child of node.content) walk(child as { text?: unknown; content?: unknown });
  };
  walk(draft.doc as { content?: unknown });
  const html = (draft.import?.html ?? "").replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ");
  // The attribution line comes first in the draft; the original's words follow it.
  return `${words.join(" ")} ${html}`.replace(/\s+/g, " ").replace(/^.{0,200}?wrote:\s*/i, "");
}

function fieldOf(addresses: readonly MailAddress[]): Field {
  return { chips: addresses.map(chipText), text: "" };
}

/** The typed rest committed as chips (pieces under MIN_CHIP_LENGTH stay typed). */
function committed(field: Field): Field {
  if (field.text.trim() === "") return field;
  const { complete, rest } = splitTyped(field.text);
  const added = addChips(field.chips, [...complete, rest]);
  return { chips: added.chips, text: added.kept.join(", ") };
}

/** Chips the server takes: MIN_CHIP_LENGTH to MAX_CHIP_LENGTH characters. */
function savable(chips: readonly string[]): string[] {
  return chips.filter((chip) => chip.length >= MIN_CHIP_LENGTH && chip.length <= MAX_CHIP_LENGTH);
}

function docIsEmpty(doc: EditorDoc): boolean {
  const walk = (node: EditorDoc): boolean =>
    (node.text ?? "").trim() === "" && (node.content ?? []).every(walk);
  return walk(doc);
}

const ORIGINAL_KEPT_TEXT =
  "The original draft stays on the server: it could not be loaded in full, so this draft is saved beside it.";

function warningText(warning: ComposeWarningKind, dropped: readonly string[]): string[] {
  const lines: string[] = [];
  if (warning === "original_unavailable") {
    lines.push("The original message could not be read from the server, so its attachments and Reply-To are left out.");
  }
  if (warning === "attachments_left_out") lines.push("Some attachments of the original were too large and are left out.");
  if (warning === "original_kept") lines.push(ORIGINAL_KEPT_TEXT);
  if (dropped.length > 0) lines.push(`Left out: ${dropped.join(", ")}`);
  return lines;
}

/**
 * The composer for one draft. A Reload after a conflict starts it again
 * from the stored draft.
 */
export function Composer(props: ComposerProps) {
  const [shown, setShown] = useState({ from: props.draft, draft: props.draft, generation: 0 });
  // A new draft from the host replaces whatever was loaded.
  if (shown.from !== props.draft) {
    setShown({ from: props.draft, draft: props.draft, generation: shown.generation + 1 });
  }
  return (
    <ComposerBody
      key={`${shown.draft.id}:${shown.generation}`}
      {...props}
      // A drafted reply goes in once: a Reload or a new draft starts from what is stored.
      {...(shown.generation > 0 ? { initialOwn: undefined } : {})}
      draft={shown.draft}
      onReloaded={(next) =>
        setShown((prev) => ({ from: prev.from, draft: next, generation: prev.generation + 1 }))
      }
    />
  );
}

function ComposerBody(props: ComposerProps & { onReloaded: (draft: DraftView) => void }) {
  const { draft, ports, accounts } = props;
  const rootRef = useRef<HTMLElement | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  // Typing speed: the editor reads the settings on every key, so a change applies without a new editor.
  // Typing a `;` and a few letters lists the templates under the toolbar; Enter, Tab or a click takes one.
  const [snippetList, setSnippetList] = useState<SnippetList | null>(null);
  const pickSnippet = useRef<(id: string) => void>(() => {});
  const typingOf = (): TypingOptions => ({
    ...(props.typing ?? NO_TYPING),
    snippets: props.templates ?? [],
    onSnippets: setSnippetList,
    onPickSnippet: (id) => pickSnippet.current(id),
  });
  const typingRef = useRef<TypingOptions>(typingOf());
  typingRef.current = typingOf();
  const typingNow = useCallback(() => typingRef.current, []);
  const [linkOpen, setLinkOpen] = useState(false);
  const [from, setFrom] = useState<{ accountId: string; address: string | null }>({
    accountId: draft.accountId,
    address: draft.fromAddress,
  });
  const accountId = from.accountId;
  /** The owner edited the signature, so a From change kept it: Use <address>'s replaces it. */
  const [keptSignature, setKeptSignature] = useState<FromChoice | null>(null);
  const [presend, setPresend] = useState<PresendIssue[] | null>(null);
  /** Slice 3f: Improve's menu and request, and the reply reminder beside Send. */
  const [improveOpen, setImproveOpen] = useState(false);
  const [improveRequest, setImproveRequest] = useState<ImproveRequest | null>(null);
  /** AI writes mail: the Write dialog, and the owner's range as it was sent with the last request. */
  const [writeOpen, setWriteOpen] = useState(false);
  const writeSent = useRef<string[] | null>(null);
  const [remind, setRemind] = useState(false);
  const remindRef = useRef(remind);
  // Slice 3k: OpenPGP for this message. Both start off; the choice is not kept with the draft.
  const [pgpSign, setPgpSign] = useState(false);
  const [pgpEncrypt, setPgpEncrypt] = useState(false);
  const [pgpState, setPgpState] = useState<{ canSign: boolean; missing: string[] } | null>(null);
  const pgpRef = useRef({ sign: false, encrypt: false });
  remindRef.current = remind;
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [to, setTo] = useState<Field>(() => fieldOf(draft.to));
  const [cc, setCc] = useState<Field>(() => fieldOf(draft.cc));
  const [bcc, setBcc] = useState<Field>(() => fieldOf(draft.bcc));
  const [showCopies, setShowCopies] = useState(draft.cc.length > 0 || draft.bcc.length > 0);
  const [subject, setSubject] = useState(draft.subject);
  const [attachments, setAttachments] = useState<ComposeAttachment[]>(draft.attachments);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [conflict, setConflict] = useState<Conflict>(draft.queued ? { revision: draft.revision, queued: true } : null);
  const [sending, setSending] = useState(false);
  const [sendProblem, setSendProblem] = useState<string | null>(null);
  const [escapeOpen, setEscapeOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  /** The import lost content: the continued foreign draft stays on the server. */
  const [originalKept, setOriginalKept] = useState(false);

  // Latest values for saves that run after a render.
  const fields = useRef({ accountId, fromAddress: from.address, to, cc, bcc, subject, attachments });
  fields.current = { accountId, fromAddress: from.address, to, cc, bcc, subject, attachments };
  const doc = useRef<EditorDoc>(draft.doc as EditorDoc);
  const revision = useRef(draft.revision);
  /** The From the server has: a save sends fromAddress only when it differs, so a removed alias still saves. */
  const savedFrom = useRef({ accountId: draft.accountId, fromAddress: draft.fromAddress });
  /** Bumped by every change; `savedVersion` is the one the last save held. */
  const version = useRef(0);
  const savedVersion = useRef(0);
  /** Something changed while this composer was open (a close saves the server copy). */
  const edited = useRef(false);
  const conflictRef = useRef<Conflict>(conflict);
  conflictRef.current = conflict;
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingRef = useRef(false);
  const attempt = useRef<{ revision: number; requestId: string } | null>(null);
  const closed = useRef(false);
  const portsRef = useRef(ports);
  portsRef.current = ports;

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const smtpReady = account?.smtpConfigured === true;
  const fromChoices = fromChoicesOf(accounts, props.identities, from);
  const chosen = currentChoice(fromChoices, from);
  const fromAccounts = new Set(fromChoices.map((c) => c.accountId));
  const uploading = uploads.some((u) => u.error === null);

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  /** One save at a time, in order. Resolves "saved", "conflict" or "error". `imported`: the editor's load of the import. */
  const save = (server: boolean, imported = false): Promise<"saved" | "conflict" | "error"> => {
    clearTimer();
    const run = async (): Promise<"saved" | "conflict" | "error"> => {
      if (conflictRef.current !== null) return "conflict";
      const at = version.current;
      const current = fields.current;
      const fromChanged =
        current.accountId !== savedFrom.current.accountId || current.fromAddress !== savedFrom.current.fromAddress;
      setSaveState({ kind: "saving" });
      try {
        const result = await portsRef.current.save({
          draftId: draft.id,
          baseRevision: revision.current,
          accountId: current.accountId,
          ...(fromChanged ? { fromAddress: current.fromAddress } : {}),
          to: savable(current.to.chips),
          cc: savable(current.cc.chips),
          bcc: savable(current.bcc.chips),
          subject: current.subject,
          doc: doc.current,
          ...(server ? { saveToServer: true } : {}),
          ...(imported ? { imported: true } : {}),
        });
        if ("conflict" in result) {
          const next = { revision: result.revision, queued: false };
          conflictRef.current = next;
          setConflict(next);
          setSaveState({ kind: "idle" });
          return "conflict";
        }
        revision.current = result.revision;
        if (fromChanged && !imported) savedFrom.current = { accountId: current.accountId, fromAddress: current.fromAddress };
        if (result.originalKept === true) setOriginalKept(true);
        savedVersion.current = Math.max(savedVersion.current, at);
        setSaveState(version.current === at ? { kind: "saved" } : { kind: "unsaved" });
        return "saved";
      } catch (error) {
        setSaveState({ kind: "error", text: messageOf(error) });
        return "error";
      }
    };
    const next = chain.current.then(run, run);
    chain.current = next;
    return next;
  };

  /** A change: the draft saves itself once typing rests. */
  const changed = () => {
    version.current += 1;
    edited.current = true;
    setSendProblem(null);
    if (conflictRef.current !== null) return;
    setSaveState({ kind: "unsaved" });
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      void save(false);
    }, AUTOSAVE_MS);
  };

  const dirty = () => version.current !== savedVersion.current;

  const flush = () => {
    if (dirty() && conflictRef.current === null) void save(false);
  };

  // Leaving the page (or the window) saves at once; closing the composer some
  // other way (a new conversation, another page) saves too.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimer();
      if (!closed.current && edited.current && conflictRef.current === null) void save(true);
    };
  }, []);

  const setField = (setter: (field: Field) => void) => (next: Field) => {
    setter(next);
    setMarked(new Set());
    changed();
  };

  /** Commits every field's typed rest; returns the fields as they now are. */
  const commitAll = () => {
    const next = { to: committed(to), cc: committed(cc), bcc: committed(bcc) };
    if (next.to !== to || next.cc !== cc || next.bcc !== bcc) {
      setTo(next.to);
      setCc(next.cc);
      setBcc(next.bcc);
      fields.current = { ...fields.current, ...next };
      changed();
    }
    return next;
  };

  const finish = (after: () => void) => {
    closed.current = true;
    clearTimer();
    after();
  };

  /**
   * Close: an untouched empty new draft is dropped, and so is an untouched
   * continuation of a foreign draft that stays on the server (no server copy
   * of its own; the original is still there). Anything else is saved with
   * its server copy.
   */
  const close = async () => {
    if (closing) return;
    const now = commitAll();
    const empty =
      draft.kind === "new" &&
      [now.to, now.cc, now.bcc].every((f) => f.chips.length === 0 && f.text.trim() === "") &&
      fields.current.subject.trim() === "" &&
      fields.current.attachments.length === 0 &&
      docIsEmpty(doc.current) &&
      draft.serverCopy === "none";
    const untouchedContinuation =
      draft.continues &&
      draft.revision === 1 &&
      revision.current === 1 &&
      !edited.current &&
      !dirty() &&
      (draft.serverCopy === "none" || originalKept);
    setClosing(true);
    try {
      if (empty || untouchedContinuation) {
        await portsRef.current.discard(draft.id).catch(() => undefined);
        finish(props.onClose);
        return;
      }
      if (edited.current || dirty()) {
        const outcome = await save(true);
        if (outcome !== "saved") return; // the state line or the banner says why
      }
      finish(props.onClose);
    } finally {
      setClosing(false);
    }
  };

  const discard = async () => {
    setClosing(true);
    try {
      await portsRef.current.discard(draft.id);
      finish(props.onClose);
    } catch (error) {
      setSaveState({ kind: "error", text: messageOf(error) });
    } finally {
      setClosing(false);
    }
  };

  // Slice 3k: which OpenPGP options this message can use, asked again when From or the recipients change.
  const pgpRecipients = [...to.chips, ...cc.chips].map(chipAddress).filter((a) => a !== "").join("\n");
  const hasBcc = bcc.chips.length > 0;
  const pgpCheck = props.ports.pgpCheck;
  // A null From is the account's own address.
  const pgpFrom = from.address ?? accounts.find((account) => account.id === accountId)?.email ?? "";
  useEffect(() => {
    if (pgpCheck === undefined || pgpFrom === "") return;
    let stale = false;
    const timer = setTimeout(() => {
      pgpCheck(pgpFrom, pgpRecipients === "" ? [] : pgpRecipients.split("\n")).then(
        (state) => {
          if (!stale) setPgpState(state);
        },
        () => {
          // Without an answer the row stays as it was; sending without OpenPGP still works.
        },
      );
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [pgpCheck, pgpFrom, pgpRecipients]);
  /** Why Encrypt cannot be ticked, or null when it can. */
  const pgpEncryptBlock =
    pgpState === null
      ? null
      : !pgpState.canSign
        ? tx("Make an OpenPGP key for this address in Mail settings to sign or encrypt.")
        : pgpRecipients === ""
          ? tx("Add a recipient to encrypt.")
          : hasBcc
            ? tx("An encrypted message cannot have Bcc recipients.")
            : pgpState.missing.length > 0
              ? tx("No OpenPGP key for: {missing}", { missing: pgpState.missing.join(", ") })
              : null;
  const pgpSignOn = pgpSign && pgpState?.canSign === true;
  const pgpEncryptOn = pgpEncrypt && pgpEncryptBlock === null && pgpState !== null;
  pgpRef.current = { sign: pgpSignOn, encrypt: pgpEncryptOn };

  /** Slice 3l: the time picked in "Send later" for the send in flight; null sends now. */
  const sendAtRef = useRef<string | null>(null);
  const [laterOpen, setLaterOpen] = useState(false);

  /** Queues the saved revision: one request id per Send of it, retried once. */
  const queue = async (baseRevision: number) => {
    // One request id per Send of this revision: a retried call is the same send.
    const requestId =
      attempt.current !== null && attempt.current.revision === baseRevision
        ? attempt.current.requestId
        : (props.newRequestId ?? (() => crypto.randomUUID()))();
    attempt.current = { revision: baseRevision, requestId };
    const remindAfterDays = remindRef.current && props.reminderDays !== undefined ? props.reminderDays : undefined;
    const protect = pgpRef.current;
    const input = {
      draftId: draft.id,
      baseRevision,
      requestId,
      ...(remindAfterDays !== undefined ? { remindAfterDays } : {}),
      ...(protect.sign || protect.encrypt ? { protect } : {}),
      ...(sendAtRef.current !== null ? { sendAt: sendAtRef.current } : {}),
    };
    let outbox: { outboxId: string; sendAfter: string };
    try {
      outbox = await portsRef.current.send(input);
    } catch {
      try {
        outbox = await portsRef.current.send(input);
      } catch (error) {
        setSendProblem(messageOf(error));
        return;
      }
    }
    finish(() => props.onSent(outbox));
  };

  /** Runs `work` as the one send in flight. */
  const sendingRun = async (work: () => Promise<void>) => {
    sendingRef.current = true;
    setSending(true);
    setSendProblem(null);
    try {
      await work();
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  /**
   * Send: the local checks, a save when something changed, then the
   * advisory pre-send check. Issues open "Before you send"; none, or any
   * failure of the check, queues the send (slice 3d: no check blocks).
   */
  const send = async (sendAt: string | null = null) => {
    if (sendingRef.current || closing) return;
    // "Send later" keeps its time through "Before you send" (Send anyway).
    sendAtRef.current = sendAt;
    const now = commitAll();
    const all = [...now.to.chips, ...now.cc.chips, ...now.bcc.chips];
    const typed = [now.to, now.cc, now.bcc].some((f) => f.text.trim() !== "");
    if (!smtpReady) return setSendProblem("SMTP is not set for this account.");
    if (all.length === 0) return setSendProblem("Add at least one recipient.");
    if (typed || all.some((chip) => !parseAddress(chip).ok)) {
      return setSendProblem("Fix the addresses marked in red.");
    }
    if (uploading) return setSendProblem("Wait for the attachments to finish uploading.");
    if (conflictRef.current !== null) return;
    await sendingRun(async () => {
      if (dirty()) {
        const outcome = await save(false);
        if (outcome !== "saved") return;
      }
      const baseRevision = revision.current;
      const check = portsRef.current.check;
      if (check !== undefined) {
        let issues: PresendIssue[] = [];
        try {
          issues = (await check({ draftId: draft.id, baseRevision })).issues;
        } catch {
          issues = [];
        }
        if (issues.length > 0) {
          setPresend(issues);
          return;
        }
      }
      await queue(baseRevision);
    });
  };

  /**
   * Improve: the draft is saved first, so the server reads what is on
   * screen; then the owner's range goes with the saved revision.
   */
  const startImprove = async (mode: DraftMode, instruction?: string) => {
    setImproveOpen(false);
    if (editor === null || props.improve === undefined || conflictRef.current !== null) return;
    if (dirty()) {
      const outcome = await save(false);
      if (outcome !== "saved") return;
    }
    const range = ownerRange(editor);
    setImproveRequest({
      input: {
        kind: "draft",
        draftId: draft.id,
        revision: revision.current,
        mode,
        ...(instruction !== undefined ? { instruction } : {}),
        paragraphs: range.paragraphs,
      },
      hasMarks: range.hasMarks,
    });
  };
  /** Dictation: the text goes in where the cursor is now, as paragraphs. */
  const dictation = useDictation({
    ...(props.dictationDevice ?? browserDictation),
    transcribe: (audio, signal) => (props.ports.transcribe === undefined ? Promise.reject(new Error("no voice service")) : props.ports.transcribe(audio, signal)),
    onText: (text) => {
      if (editor !== null) insertParagraphs(editor, dictatedParagraphs(text));
    },
  });
  /** Write: the draft is saved first, as for Improve; null when it could not be. */
  const prepareWrite = async (instruction: string): Promise<WriteInput | null> => {
    if (editor === null || conflictRef.current !== null) return null;
    if (dirty()) {
      const outcome = await save(false);
      if (outcome !== "saved") return null;
    }
    const range = ownerRange(editor);
    writeSent.current = range.paragraphs;
    return { kind: "write", draftId: draft.id, revision: revision.current, instruction, paragraphs: range.paragraphs };
  };
  /** Insert: only while the owner's range is still what was sent. */
  const insertWritten = (paragraphs: string[]): boolean => {
    const sent = writeSent.current;
    if (editor === null || sent === null) return false;
    const now = ownerRange(editor).paragraphs;
    if (now.length !== sent.length || now.some((p, i) => p !== sent[i])) return false;
    replaceOwnerRange(editor, paragraphs);
    return true;
  };
  /** Apply: only while the owner's range is still what was sent. */
  const applyImprove = (paragraphs: string[]): boolean => {
    const sent = improveRequest?.input.paragraphs;
    if (editor === null || sent === undefined) return false;
    const now = ownerRange(editor).paragraphs;
    if (now.length !== sent.length || now.some((p, i) => p !== sent[i])) return false;
    replaceOwnerRange(editor, paragraphs);
    return true;
  };

  /** Before you send → Send anyway. */
  const sendAnyway = async () => {
    setPresend(null);
    if (sendingRef.current || closing || conflictRef.current !== null) return;
    await sendingRun(async () => {
      if (dirty()) {
        const outcome = await save(false);
        if (outcome !== "saved") return;
      }
      await queue(revision.current);
    });
  };

  /** Fix on an issue: the dialog closes and the owner lands on it; returns what to focus once it has. */
  const fix = (issue: PresendIssue): (() => void) | undefined => {
    setPresend(null);
    const within = (selector: string) => rootRef.current?.querySelector<HTMLElement>(selector) ?? null;
    switch (issue.kind) {
      case "attachment_mentioned":
        // The picker opens inside the click, as a browser requires.
        within('input[type="file"]')?.click();
        return undefined;
      case "empty_subject":
        return () => rootRef.current?.ownerDocument.getElementById(`compose-subject-${draft.id}`)?.focus();
      case "outside_conversation":
      case "new_recipients":
      case "reply_to_elsewhere": {
        const wanted = new Set(issue.addresses.map((a) => a.toLowerCase()));
        setMarked(wanted);
        const holds = (field: Field) => field.chips.some((chip) => wanted.has(chipAddress(chip)));
        const field = holds(to) ? "To" : holds(cc) ? "Cc" : holds(bcc) ? "Bcc" : "To";
        if (field !== "To") setShowCopies(true);
        // The field is found by its label, which is shown in the page's language.
        return () => within(`input[role="combobox"][aria-label="${tx(field)}"]`)?.focus();
      }
      case "bb_files":
      case "placeholder_left":
      case "looks_secret":
        // The dialog closes; the owner checks the attachments or the text.
        return undefined;
    }
  };

  /** From changed: an unedited signature becomes the new identity's; an edited one stays, with a note. */
  const chooseFrom = (key: string) => {
    const next = fromChoices.find((choice) => choice.key === key);
    if (next === undefined || next.key === chosen?.key) return;
    const previous = chosen;
    const fromAddress = next.primary ? null : next.address;
    setFrom({ accountId: next.accountId, address: fromAddress });
    fields.current = { ...fields.current, accountId: next.accountId, fromAddress };
    setKeptSignature(null);
    const found = editor !== null ? findSignature(editor.state.doc) : null;
    if (found !== null) {
      const current = signatureKey((found.node.toJSON() as EditorDoc).content);
      const replaceable =
        current === signatureKey([]) || (previous !== null && current === signatureKey(previous.signature?.content));
      if (replaceable) replaceSignature(next.signature);
      else if (current !== signatureKey(next.signature?.content)) setKeptSignature(next);
    }
    changed();
  };

  const replaceSignature = (signature: EditorDoc | null) => {
    if (editor === null) return;
    const found = findSignature(editor.state.doc);
    if (found === null) return;
    editor
      .chain()
      .command(({ tr, state }) => {
        const node = state.schema.nodeFromJSON({ type: "signature", content: signature?.content ?? [] });
        tr.replaceWith(found.pos, found.pos + found.node.nodeSize, node);
        return true;
      })
      .run();
  };

  // Instant intro: in a reply whose first recipient is the original's sender and that has someone else to write to.
  const introSender = draft.kind === "reply" || draft.kind === "reply_all" ? (draft.to[0] ?? null) : null;
  const introMove =
    introSender === null ? null : moveSenderToBcc({ to: to.chips, cc: cc.chips, bcc: bcc.chips }, introSender.address);
  const [introDismissed, setIntroDismissed] = useState(false);
  const introOffered =
    introMove !== null &&
    !introDismissed &&
    // Not when the owner answers their own message: there is nobody to thank.
    !accounts.some((owned) => owned.email.toLowerCase() === introSender?.address.toLowerCase()) &&
    looksLikeIntro({ subject: draft.subject, text: introText(draft) });
  const moveIntroducer = () => {
    if (introMove === null || introSender === null) return;
    setTo({ ...to, chips: introMove.to });
    setCc({ ...cc, chips: introMove.cc });
    setBcc({ ...bcc, chips: introMove.bcc });
    setShowCopies(true);
    const line = introLine(firstNameOf(introSender), draft.subject);
    editor?.chain().focus().insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: line }] }).run();
    changed();
  };

  /** Typing speed: files of the last template that the message had no room for. */
  const [templateLeftOut, setTemplateLeftOut] = useState<string[]>([]);
  /** Why a template's files could not be attached at all. */
  const [templateFailed, setTemplateFailed] = useState<string | null>(null);
  /**
   * A template goes in at the cursor and fills what it carries: an empty
   * subject, recipients the draft does not have yet, `{first_name}` (the
   * first To recipient's, counting the template's own), and its files.
   */
  const insertTemplate = (template: TemplateView) => {
    setTemplatesOpen(false);
    if (editor === null) return;
    const nextTo = mergeRecipients(to.chips, template.to ?? [], [...cc.chips, ...bcc.chips]);
    const nextCc = mergeRecipients(cc.chips, template.cc ?? [], [...nextTo, ...bcc.chips]);
    const nextBcc = mergeRecipients(bcc.chips, template.bcc ?? [], [...nextTo, ...nextCc]);
    if (nextTo.length !== to.chips.length) setTo({ ...to, chips: nextTo });
    if (nextCc.length !== cc.chips.length) setCc({ ...cc, chips: nextCc });
    if (nextBcc.length !== bcc.chips.length) setBcc({ ...bcc, chips: nextBcc });
    if (nextCc.length > 0 || nextBcc.length > 0) setShowCopies(true);
    const first = nextTo[0] === undefined ? undefined : parseAddress(nextTo[0]);
    const firstName = firstNameOf(first?.ok === true ? first.value : undefined);
    const ownSubject = (template.subject ?? "").trim();
    if (subject.trim() === "" && ownSubject !== "") setSubject(fillVariables(ownSubject, firstName));
    editor.chain().focus().insertContent(fillBlocks((template.doc.content ?? []) as { type: string }[], firstName)).run();
    changed();
    setTemplateLeftOut([]);
    setTemplateFailed(null);
    const apply = portsRef.current.applyTemplate;
    if ((template.files?.length ?? 0) === 0 || apply === undefined) return;
    apply({ draftId: draft.id, templateId: template.id }).then(
      ({ attached, leftOut }) => {
        if (attached.length > 0) setAttachments((prev) => [...prev, ...attached]);
        setTemplateLeftOut(leftOut);
      },
      (error: unknown) => setTemplateFailed(messageOf(error)),
    );
  };

  pickSnippet.current = (id) => {
    const template = props.templates?.find((item) => item.id === id);
    if (template !== undefined) insertTemplate(template);
  };

  const [bbMenuOpen, setBbMenuOpen] = useState(false);
  const [bbPick, setBbPick] = useState<FilePickRequest | null>(null);

  const addFiles = (files: File[]) => {
    for (const file of files) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setUploads((prev) => [...prev, { key, fileName: file.name || "attachment", size: file.size, sent: 0, error: null }]);
      void uploadFile(portsRef.current.upload, draft.id, file, (sent) =>
        setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, sent } : u))),
      ).then(
        (attachment) => {
          setUploads((prev) => prev.filter((u) => u.key !== key));
          setAttachments((prev) => [...prev, attachment]);
          changed();
        },
        (error: unknown) =>
          setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, error: messageOf(error) } : u))),
      );
    }
  };

  const removeAttachment = async (attachmentId: string) => {
    try {
      await portsRef.current.removeAttachment(draft.id, attachmentId);
      setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
      changed();
    } catch (error) {
      setSaveState({ kind: "error", text: messageOf(error) });
    }
  };

  const reload = async () => {
    try {
      props.onReloaded(await portsRef.current.reload(draft.id));
    } catch (error) {
      setSaveState({ kind: "error", text: messageOf(error) });
    }
  };

  const keepMine = () => {
    if (conflict === null) return;
    revision.current = conflict.revision;
    conflictRef.current = null;
    setConflict(null);
    void save(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Keys in a portal (the From list, a dialog) are theirs.
    if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void send();
      return;
    }
    // Slice 3i (part B resolution 9): Apple Mail's Shift+Command+D, by the physical key, through the same pre-send.
    if (
      (props.mac ?? isMacPlatform()) &&
      event.metaKey &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      event.code === "KeyD" &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.stopPropagation();
      void send();
      return;
    }
    // Mod+J: Write with AI.
    if (
      (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.code === "KeyJ" &&
      props.improve !== undefined && props.improve.disabledReason === null
    ) {
      event.preventDefault();
      event.stopPropagation();
      setWriteOpen(true);
      return;
    }
    // Mod+Shift+I: answering an introduction, the introducer goes to Bcc with a thank-you line.
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.code === "KeyI" && introMove !== null) {
      event.preventDefault();
      event.stopPropagation();
      moveIntroducer();
      return;
    }
    // Mod+Alt+T: the template picker (Alt+T and Alt+Shift+T are BB's model picker).
    if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === "KeyT" && props.templates !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      setTemplatesOpen(true);
      return;
    }
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      if (dirty() || [to, cc, bcc].some((f) => f.text.trim() !== "")) setEscapeOpen(true);
      else void close();
    }
  };

  const hasDragFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const lines = warningText(props.warning ?? null, props.dropped ?? []);
  if (originalKept && !lines.includes(ORIGINAL_KEPT_TEXT)) lines.push(ORIGINAL_KEPT_TEXT);
  const noRecipients = [to, cc, bcc].every((f) => f.chips.length === 0 && f.text.trim() === "");
  const page = props.layout === "page";

  return (
    <section
      ref={rootRef}
      aria-label={tx(TITLES[draft.kind])}
      data-mail-composer=""
      onKeyDown={onKeyDown}
      onFocus={() => props.onFocusWithin?.(true)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && rootRef.current?.contains(next)) return;
        props.onFocusWithin?.(false);
        flush();
      }}
      onDragOver={(event) => {
        if (hasDragFiles(event)) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.defaultPrevented) return;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        event.preventDefault();
        addFiles(files);
      }}
      className={cn(
        "flex min-h-0 min-w-0 flex-col bg-background",
        page ? "h-full flex-1" : "rounded-lg border border-border",
      )}
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {page ? (
          <Button variant="ghost" size="sm" onClick={() => void close()} disabled={closing}>
            <Icon name="ArrowLeft" aria-hidden />
            {tx("Back")}
          </Button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-foreground">{tx(TITLES[draft.kind])}</h2>
        {typeof draft.preparedBy === "string" ? (
          <span className="flex min-w-0 shrink items-center gap-1 rounded-sm bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
            <Icon name="Plug" fallback="Mail" className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{tx("Prepared by {plugin}", { plugin: draft.preparedBy })}</span>
          </span>
        ) : null}
        {draft.origin === "agent" ? (
          <span className="flex shrink-0 items-center gap-1 rounded-sm bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
            <Icon name="Bot" fallback="Mail" className="size-3.5" aria-hidden />
            {tx("Started by an agent")}
          </span>
        ) : null}
        {!page ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={tx("Close")}
            disabled={closing}
            onClick={() => void close()}
          >
            <Icon name="X" fallback="ArrowLeft" aria-hidden />
          </Button>
        ) : null}
      </div>

      {conflict !== null ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 text-foreground">
            {conflict.queued
              ? tx("A send of this draft is queued. Undo it to edit the draft.")
              : tx("This draft changed in another window.")}
          </span>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            {tx("Reload")}
          </Button>
          {!conflict.queued ? (
            <Button variant="ghost" size="sm" onClick={keepMine}>
              {tx("Keep mine")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {lines.length > 0 ? (
        <div role="status" className="flex flex-col gap-0.5 border-b border-border px-3 py-2 text-xs text-muted-foreground">
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}

      <FieldRow label={tx("From")}>
        {fromChoices.length > 1 ? (
          <Select value={chosen?.key ?? ""} onValueChange={chooseFrom}>
            <SelectTrigger aria-label={tx("From")} className="h-7 w-auto max-w-80 border-none px-1 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fromAccounts.size > 1
                ? [...fromAccounts].map((id) => {
                    const owner = accounts.find((a) => a.id === id);
                    return (
                      <SelectGroup key={id}>
                        <SelectLabel>{owner !== undefined ? accountLabel(owner) : id}</SelectLabel>
                        {fromChoices.filter((c) => c.accountId === id).map(fromItem)}
                      </SelectGroup>
                    );
                  })
                : fromChoices.map(fromItem)}
            </SelectContent>
          </Select>
        ) : (
          <span className="truncate px-1 text-sm text-foreground">{chosen?.label ?? (account !== null ? accountLabel(account) : "")}</span>
        )}
      </FieldRow>
      {chosen !== null && (chosen.missing || sendCheckText(chosen.sendCheck) !== null) ? (
        <p role="status" className="flex items-start gap-1 border-b border-border px-3 py-1.5 text-xs text-destructive">
          <Icon name="TriangleAlert" fallback="Info" className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {chosen.missing
            ? tx("This sending address is no longer set up for the account; choose another From.")
            : sendCheckText(chosen.sendCheck)}
        </p>
      ) : null}
      {introOffered ? (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{tx("This looks like an introduction.")}</span>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={moveIntroducer}>
            {tx("Move sender to Bcc")}
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setIntroDismissed(true)}>
            {tx("Not now")}
          </Button>
        </div>
      ) : null}
      {templateFailed !== null ? (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-destructive">
          {tx("The template's files were not attached: {p1}", { p1: tx(templateFailed) })}
        </p>
      ) : null}
      {templateLeftOut.length > 0 ? (
        <p role="status" className="flex items-start gap-1 border-b border-border px-3 py-1.5 text-xs text-destructive">
          <Icon name="TriangleAlert" fallback="Info" className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {tx("No room in this message for: {p1}", { p1: templateLeftOut.join(", ") })}
        </p>
      ) : null}
      {keptSignature !== null ? (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span>{tx("Kept your edited signature")}</span>
          <span aria-hidden>·</span>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => {
              replaceSignature(keptSignature.signature);
              setKeptSignature(null);
            }}
          >
            {tx("Use")} {keptSignature.address}'s
          </Button>
        </div>
      ) : null}
      {!smtpReady ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 text-destructive">{tx("SMTP is not set for this account.")}</span>
          <Button variant="outline" size="sm" onClick={() => props.onOpenSmtpSettings(accountId)}>
            {tx("Set up SMTP")}
          </Button>
        </div>
      ) : null}

      <FieldRow label={tx("To")}>
        <RecipientInput
          label={tx("To")}
          chips={to.chips}
          text={to.text}
          onChange={setField(setTo)}
          suggest={(prefix) => portsRef.current.suggest(prefix)}
          autoFocus={draft.kind === "new" || draft.kind === "forward"}
          marked={marked}
        />
        {!showCopies ? (
          <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2" onClick={() => setShowCopies(true)}>
            {tx("Cc Bcc")}
          </Button>
        ) : null}
      </FieldRow>
      {showCopies ? (
        <>
          <FieldRow label={tx("Cc")}>
            <RecipientInput label={tx("Cc")} chips={cc.chips} text={cc.text} onChange={setField(setCc)} suggest={(p) => portsRef.current.suggest(p)} marked={marked} />
          </FieldRow>
          <FieldRow label={tx("Bcc")}>
            <RecipientInput label={tx("Bcc")} chips={bcc.chips} text={bcc.text} onChange={setField(setBcc)} suggest={(p) => portsRef.current.suggest(p)} marked={marked} />
          </FieldRow>
        </>
      ) : null}
      <FieldRow label={tx("Subject")} htmlFor={`compose-subject-${draft.id}`}>
        <input
          id={`compose-subject-${draft.id}`}
          type="text"
          value={subject}
          maxLength={998}
          autoComplete="off"
          onChange={(event) => {
            const next = event.target.value.replace(/[\r\n\u0000]+/g, " ");
            setSubject(next);
            fields.current = { ...fields.current, subject: next };
            changed();
          }}
          className="h-7 w-full min-w-0 bg-transparent px-1 text-sm text-foreground outline-none"
        />
      </FieldRow>

      <div className="border-b border-border px-2 py-1">
        <ComposeToolbar
          editor={editor}
          linkOpen={linkOpen}
          onLinkOpenChange={setLinkOpen}
          {...(props.templates !== undefined
            ? { onTemplates: () => setTemplatesOpen((open) => !open), templatesOpen }
            : {})}
          {...(props.improve !== undefined
            ? {
                onImprove: () => setImproveOpen((open) => !open),
                improveOpen,
                improveDisabledReason: props.improve.disabledReason,
                onWrite: () => setWriteOpen(true),
              }
            : {})}
          {...(props.ports.transcribe !== undefined
            ? { dictation: { state: dictation.state, onToggle: dictation.toggle, onCancel: dictation.cancel, onRetry: dictation.retry } }
            : {})}
        />
        {improveOpen && props.improve !== undefined ? (
          <ImproveMenu
            onPick={(mode, instruction) => void startImprove(mode, instruction)}
            onClose={() => {
              setImproveOpen(false);
              editor?.commands.focus();
            }}
          />
        ) : null}
        {templatesOpen && props.templates !== undefined ? (
          <TemplatesPopover
            templates={props.templates}
            onInsert={insertTemplate}
            onManage={() => {
              setTemplatesOpen(false);
              props.onManageTemplates?.();
            }}
            onClose={() => {
              setTemplatesOpen(false);
              editor?.commands.focus();
            }}
          />
        ) : null}
      </div>
      {snippetList !== null && editor !== null ? (
        <ul role="listbox" aria-label={tx("Templates for ;{p1}", { p1: snippetList.query })} className="flex shrink-0 flex-col border-b border-border px-1 py-1">
          {snippetList.items.map((item, index) => (
            <li
              key={item.id}
              role="option"
              aria-selected={index === snippetList.highlight}
              // The editor keeps the focus and its cursor: the pick happens on the press, not after a blur.
              onMouseDown={(event) => {
                event.preventDefault();
                takeSnippet(editor.view, item.id, typingRef.current);
              }}
              className={cn(
                "cursor-default truncate rounded-md px-2 py-1 text-sm text-foreground",
                index === snippetList.highlight ? "bg-state-active" : "hover:bg-state-hover",
              )}
            >
              {item.name}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ComposeEditor
          label={tx("Message")}
          initialDoc={draft.doc as EditorDoc}
          importFrom={draft.import}
          {...(props.initialOwn !== undefined ? { initialOwn: props.initialOwn } : {})}
          onChange={(next) => {
            doc.current = next;
            changed();
          }}
          onFiles={addFiles}
          onReady={setEditor}
          onImported={(next) => {
            doc.current = next;
            void save(false, true);
          }}
          onLinkShortcut={() => setLinkOpen(true)}
          typing={typingNow}
        />
        <AttachmentChips
          attachments={attachments}
          uploads={uploads}
          onRemove={(id) => void removeAttachment(id)}
          onDismissUpload={(key) => setUploads((prev) => prev.filter((u) => u.key !== key))}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        <Button
          size="sm"
          onClick={() => void send()}
          disabled={sending || closing || noRecipients || !smtpReady || conflict !== null}
          aria-keyshortcuts="Control+Enter Meta+Enter"
        >
          <Icon name="Send" fallback="Mail" aria-hidden />
          {sending ? tx("Sending\u2026") : tx("Send")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2"
          aria-haspopup="dialog"
          onClick={() => setLaterOpen(true)}
          disabled={sending || closing || noRecipients || !smtpReady || conflict !== null}
        >
          <Icon name="Clock" fallback="Mail" aria-hidden />
          {tx("Send later")}
        </Button>
        <SendLaterMenu
          open={laterOpen}
          onOpenChange={setLaterOpen}
          {...(props.ports.smartSend !== undefined
            ? {
                smart: async () => {
                  // The server reads the saved draft's recipients.
                  if (dirty() && (await save(false)) !== "saved") return null;
                  return props.ports.smartSend!(draft.id);
                },
              }
            : {})}
          onPick={(at) => {
            setLaterOpen(false);
            void send(at);
          }}
        />
        <AttachButton onAdd={addFiles} disabled={closing} />
        {props.bbFiles !== undefined ? (
          <span className="relative inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              aria-haspopup="menu"
              aria-expanded={bbMenuOpen}
              disabled={closing}
              onClick={() => setBbMenuOpen((open) => !open)}
            >
              {tx("Attach from BB \u25be")}
            </Button>
            {bbMenuOpen ? (
              <span
                role="menu"
                aria-label={tx("Attach from BB")}
                className="absolute bottom-full left-0 z-10 mb-1 flex min-w-44 flex-col rounded-md border border-border bg-popover p-1 shadow-md"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setBbMenuOpen(false);
                  }
                }}
              >
                {(
                  [
                    ["project", "From a project\u2026"],
                    ["thread", "From a thread\u2026"],
                  ] as const
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    className="rounded-sm px-2 py-1 text-left text-sm text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => {
                      setBbMenuOpen(false);
                      setBbPick({ kind, draftId: draft.id });
                    }}
                  >
                    {label}
                  </button>
                ))}
              </span>
            ) : null}
          </span>
        ) : null}
        {props.reminderDays !== undefined ? (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              aria-label={tx("Remind me if no reply in {p1}", { p1: daysText(props.reminderDays) })}
              checked={remind}
              onCheckedChange={(checked) => setRemind(checked === true)}
            />
            {tx("Remind me if no reply in {p1}", { p1: daysText(props.reminderDays) })}
          </label>
        ) : null}
        {pgpState !== null ? (
          <span role="group" aria-label={tx("OpenPGP")} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5">
              <Checkbox
                aria-label={tx("Sign with OpenPGP")}
                checked={pgpSignOn}
                disabled={!pgpState.canSign}
                onCheckedChange={(checked) => setPgpSign(checked === true)}
              />
              {tx("Sign")}
            </label>
            <label className="flex items-center gap-1.5">
              <Checkbox
                aria-label={tx("Encrypt with OpenPGP")}
                checked={pgpEncryptOn}
                disabled={pgpEncryptBlock !== null}
                onCheckedChange={(checked) => setPgpEncrypt(checked === true)}
              />
              {tx("Encrypt")}
            </label>
            {pgpEncryptOn ? <span>{tx("The subject and the addresses are not encrypted.")}</span> : null}
            {!pgpEncryptOn && pgpEncryptBlock !== null && (pgpEncrypt || pgpState.canSign) ? <span>{pgpEncryptBlock}</span> : null}
          </span>
        ) : null}
        <SaveStateLine state={saveState} serverCopy={draft.serverCopy} />
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={tx("Discard draft")}
          disabled={closing || sending}
          onClick={() => void discard()}
        >
          <Icon name="Trash2" aria-hidden />
        </Button>
        {sendProblem !== null ? (
          <p role="alert" className="w-full text-xs text-destructive">
            {sendProblem}
          </p>
        ) : null}
      </div>

      {props.improve !== undefined ? (
        <WriteDialog
          open={writeOpen}
          ports={props.improve.jobs}
          prepare={prepareWrite}
          onInsert={insertWritten}
          onClose={() => {
            setWriteOpen(false);
            editor?.commands.focus();
          }}
        />
      ) : null}
      {props.improve !== undefined ? (
        <ImproveDialog
          request={improveRequest}
          ports={props.improve.jobs}
          onApply={applyImprove}
          onClose={() => {
            setImproveRequest(null);
            editor?.commands.focus();
          }}
        />
      ) : null}
      {props.bbFiles !== undefined ? (
        <BbFilePicker
          request={bbPick}
          call={props.bbFiles.call}
          currentProjectId={props.bbFiles.projectId}
          currentThreadId={props.bbFiles.threadId}
          onAttached={(added) => {
            if (added.length === 0) return;
            setAttachments((prev) => [...prev, ...added]);
            changed();
          }}
          onClose={() => setBbPick(null)}
        />
      ) : null}
      <PresendDialog
        issues={presend}
        onFix={fix}
        onBack={() => setPresend(null)}
        onSendAnyway={() => void sendAnyway()}
      />

      <Dialog open={escapeOpen} onOpenChange={setEscapeOpen}>
        <DialogContent className="max-w-sm" onEscapeKeyDown={stopEscape}>
          <DialogHeader>
            <DialogTitle>{tx("Close this draft?")}</DialogTitle>
            <DialogDescription>{tx("It has changes that are not saved yet.")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setEscapeOpen(false)}>
              {tx("Keep editing")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEscapeOpen(false);
                void discard();
              }}
            >
              {tx("Discard")}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEscapeOpen(false);
                void close();
              }}
            >
              {tx("Save draft")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function FieldRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-2 border-b border-border px-3">
      {htmlFor !== undefined ? (
        <label htmlFor={htmlFor} className="w-14 shrink-0 text-xs text-muted-foreground">
          {label}
        </label>
      ) : (
        <span aria-hidden className="w-14 shrink-0 text-xs text-muted-foreground">
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

function SaveStateLine({ state, serverCopy }: { state: SaveState; serverCopy: DraftView["serverCopy"] }) {
  const text =
    state.kind === "saving"
      ? tx("Saving\u2026")
      : state.kind === "unsaved"
        ? tx("Not saved yet")
        : state.kind === "error"
          ? tx("Not saved: {text}", { text: state.text })
          : serverCopy === "failed"
            ? tx("Saved on this computer \u2014 server copy failed")
            : serverCopy === "local_only"
              ? tx("Saved on this computer")
              : state.kind === "saved"
                ? tx("Saved")
                : "";
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn("text-xs", state.kind === "error" ? "text-destructive" : "text-muted-foreground")}
    >
      {text}
    </span>
  );
}

/** A chip's address in lower case (the chip text when it does not parse). */
function chipAddress(chip: string): string {
  const parsed = parseAddress(chip);
  return (parsed.ok ? parsed.value.address : chip.trim()).toLowerCase();
}

function fromItem(choice: FromChoice) {
  const warning = choice.missing || sendCheckText(choice.sendCheck) !== null;
  return (
    <SelectItem key={choice.key} value={choice.key}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">{choice.label}</span>
        {!choice.primary ? <span className="shrink-0 text-xs text-muted-foreground">{tx("alias")}</span> : null}
        {warning ? (
          <Icon name="TriangleAlert" fallback="Info" className="size-3.5 shrink-0 text-destructive" aria-label={tx("Check this address")} />
        ) : null}
      </span>
    </SelectItem>
  );
}
