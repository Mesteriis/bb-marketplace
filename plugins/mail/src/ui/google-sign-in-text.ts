// Why a Google sign-in did not become an account, as one sentence each for
// the account form. The reasons are the fixed codes of google_sign_in_status.
import type { RpcOut } from "../core/index.ts";
import { tx } from "./i18n/index.ts";

type Failed = Extract<RpcOut<"google_sign_in_status">, { state: "failed" }>;

export function googleSignInFailureText(reason: Failed["reason"]): string {
  switch (reason) {
    case "denied":
      return tx("The sign-in was not completed in the browser.");
    case "timeout":
      return tx("Google did not answer in time. Try again.");
    case "mismatch":
      return tx("That Google account is a different address.");
    case "no_refresh_token":
      return tx("Google did not let Mail stay signed in. Try again.");
    case "refused":
      return tx("Gmail refused the new sign-in. Check that IMAP is allowed for this account.");
    case "unreachable":
      return tx("Gmail could not be reached to finish the sign-in. Try again later.");
    case "alias":
      return tx("This address is already a sending address of another account; remove it there first.");
    case "error":
      return tx("The sign-in could not be finished. Try again.");
  }
}
