import type { Message } from "../../core/demo.ts";
import { maskSpoilers } from "../../core/message-spoilers.ts";
import type { Translate } from "./index.tsx";

export function displayMessageText(message: Message, t: Translate): string {
  if (!message.textIsLabel && !message.service) return message.text;
  if (message.service) {
    const rename = /^Chat renamed to “([\s\S]*)”$/.exec(message.text);
    if (rename) return t("Chat renamed to “{0}”", [rename[1]]);
    const members = /^(\d+) members added to the chat$/.exec(message.text);
    if (members) return t("{0} members added to the chat", [members[1]]);
    const score = /^Scored (.+) point(s?) in a game$/.exec(message.text);
    if (score) return t("Scored {0} point{1} in a game", [score[1], score[2]]);
    const timer = /^Message auto-delete set to (\d+) (day|hour|minute|second)(s?)$/.exec(message.text);
    if (timer) return t("Message auto-delete set to {0} {1}{2}", [timer[1], t(`${timer[2]}${timer[3]}`), ""]);
  }
  return t(message.text);
}

export function displayMessagePreview(message: Message | undefined, t: Translate) {
  if (message) return maskSpoilers(displayMessageText(message, t), message.styles, t("[Spoiler]"));
}
