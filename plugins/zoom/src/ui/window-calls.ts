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
  private listeners = new Set<() => void>();
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
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private change() {
    this.active = new Map(this.active);
    for (const listener of this.listeners) listener();
  }
  show(session: WindowCall, calendar = false) {
    const id = session.call.meetingNumber;
    if (!this.active.has(id)) this.active.set(id, session);
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
  end(id: string) {
    if (this.calendarMeeting === id) this.calendarMeeting = null;
    this.active.delete(id);
    this.change();
  }
}
