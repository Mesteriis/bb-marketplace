import type { Message } from "./demo.ts";

export function groupMessageAlbums(messages: readonly Message[]): Message[][] {
  const groups: Message[][] = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (previous && message.albumId && previous[0]?.albumId === message.albumId) previous.push(message);
    else groups.push([message]);
  }
  return groups;
}
