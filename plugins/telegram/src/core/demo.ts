import type { MediaCollectionKind, DocumentInfo, MessageLinkPreview, MessageReactions, MessageSender, PollInfo, StyledRange } from "./contract.ts";
import type { MessageLink } from "./message-links.ts";

export type Message = {
  id: string;
  author: string;
  time: string;
  timestamp?: number;
  text: string;
  links?: MessageLink[];
  linkPreview?: MessageLinkPreview;
  styles?: StyledRange[];
  outgoing?: boolean;
  sender?: MessageSender;
  service?: true;
  pinnedTargetId?: string;
  voiceNote?: true;
  videoNote?: true;
  animation?: true;
  collectionKind?: MediaCollectionKind;
  hasStickerPack?: true;
  albumId?: string;
  oneView?: "photo" | "video";
  retained?: "deleted" | "expired";
  isChannelPost?: boolean;
  commentCount?: number;
  viewCount?: number;
  pendingDelivery?: boolean;
  replyTo?: string;
  replyQuote?: string;
  canQuote?: true;
  authorAvatar?: { id: string; user: boolean; fileId?: number; preview?: string };
  forwardedFrom?: string;
  forumTopicId?: number;
  threadRoot?: string;
  editable?: boolean;
  editableCaption?: boolean;
  canMoveCaption?: true;
  edited?: boolean;
  editedAt?: number;
  channelSignature?: string;
  document?: DocumentInfo;
  poll?: PollInfo;
  canStopPoll?: boolean;
  reactions?: MessageReactions;
  hasPhoto?: boolean;
  photoDimensions?: { width: number; height: number };
  photoSpoiler?: boolean;
  canSavePhoto?: true;
  videoSpoiler?: true;
  captionAboveMedia?: boolean;
  photoCaption?: string;
};

export type Chat = {
  id: string;
  name: string;
  initials: string;
  avatarJpeg?: string;
  avatarFileId?: number;
  color: string;
  subtitle: string;
  work?: boolean;
  folderIds?: number[];
  unread?: number;
  markedUnread?: boolean;
  unreadMentions?: number;
  unreadReactions?: number;
  archived?: boolean;
  senderKey?: string;
  pinned?: string;
  messages: Message[];
};

export const chats: Chat[] = [
  {
    id: "product", name: "Product Discussion", initials: "PD", color: "#247b78",
    subtitle: "4 members", work: true,
    pinned: "Review the new chat layout before Friday.",
    messages: [
      { id: "p1", author: "Mia Chen", time: "10:24", text: "The new chat layout is ready for review. I kept the chat list compact so there’s more room for the conversation." },
      { id: "p2", author: "You", time: "10:27", outgoing: true, text: "Nice! Let’s check it inside BB with the project sidebar open." },
      { id: "p3", author: "Jules Park", time: "10:29", text: "I’ll check the narrow layout and keyboard navigation. We can compare notes tomorrow." },
      { id: "p4", author: "Mia Chen", time: "10:32", text: "Sounds good. I pinned the review reminder above." },
    ],
  },
  {
    id: "mia", name: "Mia Chen", initials: "MC", color: "#387c7d", subtitle: "Direct message", unread: 1,
    messages: [
      { id: "m1", author: "You", time: "09:15", outgoing: true, text: "Do you have time to review the mockups this afternoon?" },
      { id: "m2", author: "Mia Chen", time: "09:21", text: "Yes! Let’s sync at 14:00." },
    ],
  },
  {
    id: "forum", name: "Design Forum", initials: "DF", color: "#7760a4", subtitle: "24 members", work: true, unread: 4,
    messages: [{ id: "f1", author: "Sam Rivera", time: "08:53", text: "I added notes about contrast and focus states to the design checklist." }],
  },
  {
    id: "saved", name: "Saved Messages", initials: "SM", color: "#246dbd", subtitle: "Personal notes",
    messages: [{ id: "s1", author: "You", time: "08:16", outgoing: true, text: "Prototype checklist: open a chat, filter by folder, search and test the narrow layout." }],
  },
  {
    id: "david", name: "David Chen", initials: "DC", color: "#825d9b", subtitle: "Direct message",
    messages: [{ id: "d1", author: "David Chen", time: "08:02", text: "Got it, I’ll review tonight." }],
  },
  {
    id: "releases", name: "Release Notes", initials: "RN", color: "#a75436", subtitle: "Channel", work: true, unread: 2,
    messages: [{ id: "r1", author: "Release Notes", time: "07:45", text: "Preview build is ready. This round focuses on chats and conversation layout." }],
  },
];
