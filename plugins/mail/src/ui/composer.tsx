// The composer: From, To/Cc/Bcc chips, Subject, the rich-text editor,
// attachments and the footer (Send, Discard, save state). It autosaves the
// draft (the document JSON only), sends it through the outbox with one
// request id per Send (reused when the call is retried), and on Escape
// either closes or asks Save draft · Discard · Keep editing. Every RPC is an
// injected port; nothing here knows the host.
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
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
import { ComposeEditor, type EditorDoc } from "./compose-editor.tsx";
import { ComposeToolbar } from "./compose-toolbar.tsx";
import { accountLabel } from "./folder-list.tsx";
import { chipText, MAX_CHIP_LENGTH, MIN_CHIP_LENGTH, RecipientInput, addChips, splitTyped } from "./recipient-input.tsx";
import { stopEscape } from "./shortcuts.ts";
import { sendCheckText, type TemplateView } from "./mail-settings.tsx";
import { PresendDialog } from "./presend-dialog.tsx";
import { findSignature, signatureKey } from "./signature-node.ts";
import { TemplatesPopover } from "./templates-popover.tsx";

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
  /** The identity to send from: null = the account's own address (slice 3d). */
  fromAddress: string | null;
}

export type ComposerSaveResult = { revision: number; originalKept?: true } | { conflict: true; revision: number };

/** The RPC surface the composer needs, injected by the host adapter. */
export interface ComposerPorts {
  save(input: ComposerSaveInput): Promise<ComposerSaveResult>;
  send(input: { draftId: string; baseRevision: number; requestId: string }): Promise<{
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
}

export interface ComposerProps {
  draft: DraftView;
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
  new: "New message",
  reply: "Reply",
  reply_all: "Reply all",
  forward: "Forward",
};

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong";
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
  const [linkOpen, setLinkOpen] = useState(false);
  const [from, setFrom] = useState<{ accountId: string; address: string | null }>({
    accountId: draft.accountId,
    address: draft.fromAddress,
  });
  const accountId = from.accountId;
  /** The owner edited the signature, so a From change kept it: Use <address>'s replaces it. */
  const [keptSignature, setKeptSignature] = useState<FromChoice | null>(null);
  const [presend, setPresend] = useState<PresendIssue[] | null>(null);
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
      setSaveState({ kind: "saving" });
      try {
        const result = await portsRef.current.save({
          draftId: draft.id,
          baseRevision: revision.current,
          accountId: current.accountId,
          fromAddress: current.fromAddress,
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

  /** Queues the saved revision: one request id per Send of it, retried once. */
  const queue = async (baseRevision: number) => {
    // One request id per Send of this revision: a retried call is the same send.
    const requestId =
      attempt.current !== null && attempt.current.revision === baseRevision
        ? attempt.current.requestId
        : (props.newRequestId ?? (() => crypto.randomUUID()))();
    attempt.current = { revision: baseRevision, requestId };
    const input = { draftId: draft.id, baseRevision, requestId };
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
  const send = async () => {
    if (sendingRef.current || closing) return;
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
      case "new_recipients": {
        const wanted = new Set(issue.addresses.map((a) => a.toLowerCase()));
        setMarked(wanted);
        const holds = (field: Field) => field.chips.some((chip) => wanted.has(chipAddress(chip)));
        const field = holds(to) ? "To" : holds(cc) ? "Cc" : holds(bcc) ? "Bcc" : "To";
        if (field !== "To") setShowCopies(true);
        return () => within(`input[role="combobox"][aria-label="${field}"]`)?.focus();
      }
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

  const insertTemplate = (template: TemplateView) => {
    setTemplatesOpen(false);
    if (editor === null) return;
    editor.chain().focus().insertContent(template.doc.content ?? []).run();
  };

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
      aria-label={TITLES[draft.kind]}
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
            Back
          </Button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-foreground">{TITLES[draft.kind]}</h2>
        {draft.origin === "agent" ? (
          <span className="flex shrink-0 items-center gap-1 rounded-sm bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
            <Icon name="Bot" fallback="Mail" className="size-3.5" aria-hidden />
            Started by an agent
          </span>
        ) : null}
        {!page ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Close"
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
              ? "A send of this draft is queued. Undo it to edit the draft."
              : "This draft changed in another window."}
          </span>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            Reload
          </Button>
          {!conflict.queued ? (
            <Button variant="ghost" size="sm" onClick={keepMine}>
              Keep mine
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

      <FieldRow label="From">
        {fromChoices.length > 1 ? (
          <Select value={chosen?.key ?? ""} onValueChange={chooseFrom}>
            <SelectTrigger aria-label="From" className="h-7 w-auto max-w-80 border-none px-1 text-sm">
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
            ? "This sending address is no longer set up for the account; choose another From."
            : sendCheckText(chosen.sendCheck)}
        </p>
      ) : null}
      {keptSignature !== null ? (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span>Kept your edited signature</span>
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
            Use {keptSignature.address}'s
          </Button>
        </div>
      ) : null}
      {!smtpReady ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 text-destructive">SMTP is not set for this account.</span>
          <Button variant="outline" size="sm" onClick={() => props.onOpenSmtpSettings(accountId)}>
            Set up SMTP
          </Button>
        </div>
      ) : null}

      <FieldRow label="To">
        <RecipientInput
          label="To"
          chips={to.chips}
          text={to.text}
          onChange={setField(setTo)}
          suggest={(prefix) => portsRef.current.suggest(prefix)}
          autoFocus={draft.kind === "new" || draft.kind === "forward"}
          marked={marked}
        />
        {!showCopies ? (
          <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2" onClick={() => setShowCopies(true)}>
            Cc Bcc
          </Button>
        ) : null}
      </FieldRow>
      {showCopies ? (
        <>
          <FieldRow label="Cc">
            <RecipientInput label="Cc" chips={cc.chips} text={cc.text} onChange={setField(setCc)} suggest={(p) => portsRef.current.suggest(p)} marked={marked} />
          </FieldRow>
          <FieldRow label="Bcc">
            <RecipientInput label="Bcc" chips={bcc.chips} text={bcc.text} onChange={setField(setBcc)} suggest={(p) => portsRef.current.suggest(p)} marked={marked} />
          </FieldRow>
        </>
      ) : null}
      <FieldRow label="Subject" htmlFor={`compose-subject-${draft.id}`}>
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
        />
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ComposeEditor
          label="Message"
          initialDoc={draft.doc as EditorDoc}
          importFrom={draft.import}
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
          {sending ? "Sending…" : "Send"}
        </Button>
        <AttachButton onAdd={addFiles} disabled={closing} />
        <SaveStateLine state={saveState} serverCopy={draft.serverCopy} />
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Discard draft"
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

      <PresendDialog
        issues={presend}
        onFix={fix}
        onBack={() => setPresend(null)}
        onSendAnyway={() => void sendAnyway()}
      />

      <Dialog open={escapeOpen} onOpenChange={setEscapeOpen}>
        <DialogContent className="max-w-sm" onEscapeKeyDown={stopEscape}>
          <DialogHeader>
            <DialogTitle>Close this draft?</DialogTitle>
            <DialogDescription>It has changes that are not saved yet.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setEscapeOpen(false)}>
              Keep editing
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEscapeOpen(false);
                void discard();
              }}
            >
              Discard
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEscapeOpen(false);
                void close();
              }}
            >
              Save draft
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
      ? "Saving…"
      : state.kind === "unsaved"
        ? "Not saved yet"
        : state.kind === "error"
          ? `Not saved: ${state.text}`
          : serverCopy === "failed"
            ? "Saved on this computer — server copy failed"
            : serverCopy === "local_only"
              ? "Saved on this computer"
              : state.kind === "saved"
                ? "Saved"
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
        {!choice.primary ? <span className="shrink-0 text-xs text-muted-foreground">alias</span> : null}
        {warning ? (
          <Icon name="TriangleAlert" fallback="Info" className="size-3.5 shrink-0 text-destructive" aria-label="Check this address" />
        ) : null}
      </span>
    </SelectItem>
  );
}
