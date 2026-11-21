// Domain types shared by the core, the UI and the wire contract.

export interface ZoomMeeting {
  /** Zoom's meeting number as text. */
  readonly id: string;
  readonly topic: string;
  /** UTC instant in ISO 8601, or null for a meeting with no fixed time. */
  readonly startTime: string | null;
  readonly durationMinutes: number;
  readonly joinUrl: string;
  readonly passcode: string | null;
}

export interface ZoomProfile {
  readonly displayName: string;
}

export interface NewMeeting {
  readonly topic: string;
  /** UTC instant in ISO 8601; null starts an instant meeting. */
  readonly startTime: string | null;
  readonly durationMinutes: number;
  /** IANA zone Zoom shows the meeting in, e.g. "Europe/Moscow". */
  readonly timeZone: string;
}
