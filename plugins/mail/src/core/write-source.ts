// AI writes mail: what the store gives a Write request — the conversation
// the draft answers (in-scope messages only, up to the answered one) and
// the owner's voice samples. Pure over the store port.
import type { AiSourceMessage } from "./ai-input.ts";
import { VOICE_SAMPLES, voiceSamples, type WriteRequest } from "./ai-write.ts";
import type { DraftRecord, MessageHeader } from "./model.ts";
import type { MailStore } from "./ports.ts";

/** The owner's writing settings (aiVoice, aiInstructions, aiKnowledge). */
export type WriteSettings = { voice: boolean; personal: string; facts: string };

export type WriteSource = {
  request: Pick<WriteRequest, "own" | "personal" | "facts" | "voice" | "conversation">;
  /** Messages of the conversation outside AI access. */
  leftOut: number;
  personal: string;
  facts: string;
};

/** A stored message as the builders read it. */
export function sourceMessageOf(store: Pick<MailStore, "getBody">, header: MessageHeader): AiSourceMessage {
  const body = store.getBody(header.id);
  return {
    id: header.id,
    date: header.date,
    from: header.from,
    subject: header.subject,
    body: body === null ? null : { text: body.text, html: body.html },
  };
}

/**
 * The conversation up to and including `header`, in-scope messages only,
 * oldest first; `out_of_scope` when the message itself is outside AI access.
 */
export function conversationUpTo(
  store: Pick<MailStore, "getThread" | "getBody">,
  header: MessageHeader,
): "out_of_scope" | { messages: AiSourceMessage[]; leftOut: number } {
  if (!header.inAiScope) return "out_of_scope";
  const thread = header.threadId === null ? null : store.getThread(header.threadId, header.folder);
  const all = thread?.messages ?? [header];
  const at = all.findIndex((m) => m.id === header.id);
  // A copy the thread shows under another id (dedup): the message alone.
  const upTo = at < 0 ? [header] : all.slice(0, at + 1);
  const inScope = upTo.filter((m) => m.inAiScope);
  return { messages: inScope.map((m) => sourceMessageOf(store, m)), leftOut: upTo.length - inScope.length };
}

/** The voice samples for a message to `recipient` (null: none yet); empty with the voice off. */
export function voiceFor(store: Pick<MailStore, "voiceTexts">, settings: WriteSettings, recipient: string | null): string[] {
  if (!settings.voice) return [];
  return voiceSamples(recipient === null ? [] : store.voiceTexts(recipient, VOICE_SAMPLES), store.voiceTexts(null, 2 * VOICE_SAMPLES));
}

/** What Write sends for `draft` whose own paragraphs are `own`. */
export function writeSource(
  store: Pick<MailStore, "getMessage" | "getThread" | "getBody" | "voiceTexts">,
  settings: WriteSettings,
  draft: DraftRecord,
  own: readonly string[],
): "out_of_scope" | WriteSource {
  let conversation: AiSourceMessage[] = [];
  let leftOut = 0;
  if (draft.kind !== "new" && draft.sourceMessageId !== null) {
    const header = store.getMessage(draft.sourceMessageId);
    if (header !== null) {
      const found = conversationUpTo(store, header);
      if (found === "out_of_scope") return "out_of_scope";
      conversation = found.messages;
      leftOut = found.leftOut;
    }
  }
  const voice = voiceFor(store, settings, draft.to[0]?.address ?? null);
  return {
    request: { own, personal: settings.personal, facts: settings.facts, voice, conversation },
    leftOut,
    personal: settings.personal,
    facts: settings.facts,
  };
}
