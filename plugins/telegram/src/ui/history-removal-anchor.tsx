import { Component, type ReactNode, type RefObject } from "react";
import { captureHistoryScroll, isAwayFromLatest, restoreHistoryScroll } from "./history-scroll.ts";

type Props = {
  list: RefObject<HTMLElement | null>;
  removed?: ReadonlySet<string>;
  followLatest?: boolean;
  onAdjusted: (top: number) => void;
  children: ReactNode;
};
type Snapshot = {
  list: HTMLElement;
  position?: ReturnType<typeof captureHistoryScroll>;
};

export class HistoryRemovalAnchor extends Component<Props, object, Snapshot | null> {
  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { list: { current: list }, removed, followLatest } = this.props;
    if (!list || list.hidden || !removed?.size || removed === previous.removed) return null;
    const affected = Array.from(list.querySelectorAll<HTMLElement>("[data-message-id]")).some((row) => {
      const id = row.dataset.messageId;
      return id && removed.has(id) && !previous.removed?.has(id);
    });
    if (!affected) return null;
    return { list, position: followLatest && !isAwayFromLatest(list) ? undefined : captureHistoryScroll(list, "keep", removed) };
  }

  componentDidUpdate(_previous: Props, _state: object, snapshot: Snapshot | null) {
    if (!snapshot || this.props.list.current !== snapshot.list || snapshot.list.hidden) return;
    const { list, position } = snapshot;
    if (position) restoreHistoryScroll(list, position);
    else list.scrollTop = list.scrollHeight;
    this.props.onAdjusted(list.scrollTop);
  }

  render() {
    return this.props.children;
  }
}
