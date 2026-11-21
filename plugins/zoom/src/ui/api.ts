// The host-free API the Zoom page consumes. app.tsx builds an implementation
// from BB RPC; a test builds one from fakes.
import type { PreparedCall } from "../core/call.ts";
import type { NewMeeting, ZoomMeeting } from "../core/model.ts";

export interface AccountStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly displayName: string | null;
}

export interface ZoomPageApi {
  status(): Promise<AccountStatus>;
  /** The redirect URL to register in the Zoom app for this BB address. */
  redirectUri(origin: string): Promise<string>;
  beginLogin(origin: string): Promise<{ authorizeUrl: string }>;
  disconnect(): Promise<void>;
  listMeetings(): Promise<ZoomMeeting[]>;
  createMeeting(input: NewMeeting): Promise<ZoomMeeting>;
  prepareCall(input: { link: string; asHost: boolean }): Promise<PreparedCall>;
  /**
   * Opens the same call in the machine's default browser, where camera,
   * microphone and screen sharing work. `opened` false means the host could
   * not start a browser and the page should open `url` itself.
   */
  openCallInBrowser(input: { link: string; asHost: boolean }): Promise<{ url: string; opened: boolean }>;
}

export type Notify = (kind: "error" | "success" | "info", message: string) => void;
export const noNotify: Notify = () => undefined;

export function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "Не удалось выполнить действие";
}
