import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const MessageMenuSlot = createContext<{
  target: HTMLDivElement | null;
  reactions: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
  setReactions: (target: HTMLDivElement | null) => void;
} | undefined>(undefined);

export function MessageBubble({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [reactions, setReactions] = useState<HTMLDivElement | null>(null);
  return <MessageMenuSlot.Provider value={{ target, setTarget, reactions, setReactions }}>
    <div className="mtg-bubble">{children}</div>
  </MessageMenuSlot.Provider>;
}

export function MessageActionEntry({ children, reactionPicker }: { children: ReactNode; reactionPicker?: boolean }) {
  const slot = useContext(MessageMenuSlot);
  if (!slot) return children;
  const target = reactionPicker ? slot.reactions : slot.target;
  return target && createPortal(children, target);
}
