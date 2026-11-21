// The Meeting SDK JWT (HS256 over the app's Client Secret). Built on the
// server only: the page receives the finished signature, never the secret.
export interface SignatureInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly meetingNumber: string;
  /** 0 joins as a participant, 1 starts or joins as the host. */
  readonly role: 0 | 1;
  readonly nowSeconds: number;
}

/** Issue slightly in the past so a slow clock on Zoom's side still accepts it. */
const ISSUED_SKEW_SECONDS = 30;
/** Zoom requires at least 30 minutes and at most 48 hours. */
const LIFETIME_SECONDS = 2 * 60 * 60;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signMeetingSdkJwt(input: SignatureInput): Promise<string> {
  const encoder = new TextEncoder();
  const iat = input.nowSeconds - ISSUED_SKEW_SECONDS;
  const exp = iat + LIFETIME_SECONDS;
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(
    encoder.encode(
      JSON.stringify({ appKey: input.clientId, mn: input.meetingNumber, role: input.role, iat, exp, tokenExp: exp }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.clientSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(new Uint8Array(signed))}`;
}
