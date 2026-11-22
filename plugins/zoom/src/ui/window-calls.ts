import type { PreparedCall } from "../core/call";
export interface WindowCall {
  call: PreparedCall;
  title: string;
  callPageUrl: string;
  openExternal: (url: string) => void;
  openInBrowser?: () => void;
  leaving?: boolean;
  lost?: boolean;
}
export class WindowCalls {
  private active = new Map<string, WindowCall>();
  private listeners = new Set<(lostDocument?: string) => void>();
  readonly anchors = new Map<HTMLElement, string>();
  revision = 0;
  reset() {
    this.revision++;
    this.active.clear();
    this.calendarMeeting = null;
    this.change();
  }
  calendarMeeting: string | null = null;
  snapshot = () => this.active;
  subscribe = (listener: (lostDocument?: string) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private change(lostDocument?: string) {
    this.active = new Map(this.active);
    for (const listener of this.listeners) listener(lostDocument);
  }
  show(session: WindowCall, calendar = false) {
    const id = session.call.meetingNumber;
    const existing = this.active.get(id);
    if (!existing) this.active.set(id, session);
    else if (calendar) {
      this.active.set(id, { ...existing, title: session.title, openExternal: session.openExternal, openInBrowser: session.openInBrowser });
    }
    if (calendar) this.calendarMeeting = id;
    this.change();
  }
  update(id: string, props: Partial<Pick<WindowCall, "leaving" | "lost">>) {
    const session = this.active.get(id);
    if (session) {
      this.active.set(id, { ...session, ...props });
      this.change();
    }
  }
  end(id: string, reason: "ended" | "document-lost" = "ended") {
    if (this.calendarMeeting === id) this.calendarMeeting = null;
    this.active.delete(id);
    this.change(reason === "document-lost" ? id : undefined);
  }
}
