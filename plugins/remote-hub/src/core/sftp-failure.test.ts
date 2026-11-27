import { expect, test } from "vitest";
import { classifyChannelEnd, classifyOpenRefusal } from "./sftp-failure.ts";

const end = (stderr: string, refused: string | null = null) => ({ reason: "exited", exitCode: 255, refused, stderr });

test("a host key ssh does not know or that changed is never anything else", () => {
  expect(classifyChannelEnd(end("No ED25519 host key is known for box.test and you have requested strict checking.\r\nHost key verification failed.\r\n"), null)).toBe("host_key_unknown");
  expect(classifyChannelEnd(end("@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n"), null)).toBe("host_key_changed");
  expect(classifyChannelEnd(end("", "host_key"), null)).toBe("host_key_unknown");
  // even when the sign-in also failed in the same output
  expect(classifyChannelEnd(end("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nPermission denied (publickey).\n"), "absent")).toBe("host_key_changed");
});

test("a refused sign-in is auth_failed, and agent_unavailable only when an agent connection has no agent at all", () => {
  const denied = "u@box.test: Permission denied (publickey,password).\r\n";
  expect(classifyChannelEnd(end(denied), null)).toBe("auth_failed");
  expect(classifyChannelEnd(end(denied), "present")).toBe("auth_failed");
  expect(classifyChannelEnd(end(denied), "absent")).toBe("agent_unavailable");
  expect(classifyChannelEnd(end("", "credential_rejected"), null)).toBe("auth_failed");
  expect(classifyChannelEnd(end("", "login_prompt"), null)).toBe("auth_failed");
  expect(classifyChannelEnd(end("", "credential_unavailable"), null)).toBe("credential_missing");
});

test("a server that cannot be reached, has no sftp subsystem, or ended for no stated reason", () => {
  expect(classifyChannelEnd(end("ssh: Could not resolve hostname nowhere.test: nodename nor servname provided\r\n"), null)).toBe("unreachable");
  expect(classifyChannelEnd(end("ssh: connect to host 10.0.0.1 port 22: Connection refused\r\n"), "absent")).toBe("unreachable");
  expect(classifyChannelEnd(end("ssh: connect to host 10.0.0.1 port 22: Operation timed out\r\n"), null)).toBe("unreachable");
  expect(classifyChannelEnd(end("subsystem request failed on channel 0\r\n"), null)).toBe("profile_not_sftp");
  expect(classifyChannelEnd(end(""), null)).toBe("failure");
});

test("a refusal of the open itself maps to the contract's codes", () => {
  expect(classifyOpenRefusal("host_key_unknown")).toBe("host_key_unknown");
  expect(classifyOpenRefusal("keychain_locked")).toBe("keychain_locked");
  expect(classifyOpenRefusal("keychain_needs_approval")).toBe("keychain_needs_approval");
  expect(classifyOpenRefusal("credential_target_mismatch")).toBe("credential_missing");
  expect(classifyOpenRefusal("credential_missing")).toBe("credential_missing");
  expect(classifyOpenRefusal("ssh_option_rejected")).toBe("profile_needs_config");
  expect(classifyOpenRefusal("too_many_channels")).toBe("limit_exceeded");
  expect(classifyOpenRefusal("something_new")).toBe("failure");
});
