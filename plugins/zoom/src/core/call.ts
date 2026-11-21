// Gathers what the Meeting SDK needs to start or join one meeting as the
// signed-in user. The client secret signs the JWT here and goes no further.
import { DomainError } from "./errors.ts";
import { joinUrl, parseMeetingLink } from "./meeting-link.ts";
import type { ZoomProfile } from "./model.ts";
import type { AppCredentialsSource, Clock } from "./ports.ts";
import { signMeetingSdkJwt } from "./signature.ts";

export interface CallRequest {
  /** A Zoom link or a meeting number. */
  readonly link: string;
  /** True for the owner's own meeting: start or join it as the host. */
  readonly asHost: boolean;
}

export interface PreparedCall {
  readonly meetingNumber: string;
  readonly passcode: string | null;
  readonly userName: string;
  readonly signature: string;
  readonly zak: string;
  /** Opens the same meeting in the Zoom app when the embedded join is refused. */
  readonly fallbackUrl: string;
}

export interface CallDeps {
  readonly clock: Clock;
  readonly credentials: AppCredentialsSource;
  readonly api: { zak(): Promise<string>; profile(): Promise<ZoomProfile> };
}

export async function prepareCall(deps: CallDeps, request: CallRequest): Promise<PreparedCall> {
  const target = parseMeetingLink(request.link);
  const app = await deps.credentials.get();
  if (app === null) {
    throw new DomainError("not_configured", "Укажите Client ID и Client Secret приложения Zoom в настройках плагина");
  }
  const [zak, profile, signature] = await Promise.all([
    deps.api.zak(),
    deps.api.profile(),
    signMeetingSdkJwt({
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      meetingNumber: target.meetingNumber,
      role: request.asHost ? 1 : 0,
      nowSeconds: Math.floor(deps.clock.now() / 1000),
    }),
  ]);
  return {
    meetingNumber: target.meetingNumber,
    passcode: target.passcode,
    userName: profile.displayName,
    signature,
    zak,
    fallbackUrl: joinUrl(target.meetingNumber, target.passcode),
  };
}
