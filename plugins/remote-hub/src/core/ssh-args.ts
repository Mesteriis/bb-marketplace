// Host-free, pure OpenSSH argv construction. The actual connection is left
// entirely to OpenSSH; this module only validates fields and emits argv, never
// a shell and never an insecure option.
export interface SshTarget {
  host: string;
  user?: string;
  port?: number;
  configFile?: string;
  knownHostsFile?: string;
  identityFile?: string;
  /** Set by the server (never the client) when a saved secret is used: the only prompt then expected. */
  authMethod?: "password" | "publickey";
  extraOptions: string[];
}

export interface SshSpawnSpec {
  program: string;
  argv: string[];
  env: Record<string, string>;
}

export class SshArgError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SshArgError";
    this.code = code;
  }
}

/** Options that must never be emitted, and any -o outside the allowlist. */
const FORBIDDEN_OPTIONS: readonly RegExp[] = [
  /StrictHostKeyChecking\s*=\s*no/,
  /UserKnownHostsFile\s*=\s*\/dev\/null/,
  /^-?[ALRDXY]$/,
  /LocalCommand/,
  /ProxyCommand/,
  /ForwardAgent/,
  /ForwardX11/,
];

/** The explicit -o allowlist; empty means no -o is allowed. */
const ALLOWED_OPTIONS: readonly string[] = [];

const SHELL_METACHARS = /[\s\x00-\x1f\x7f-\x9f=;&|\`$<>*?!\\"'()\[\]{}~]/;

function invalid(code: string, message: string): never {
  throw new SshArgError(code, message);
}

/** The SSH host rule (non-empty, no leading '-', no shell metacharacters), shared with RDP. */
export function assertHostToken(host: string): void {
  assertToken(host, "host");
}

/** The ssh -l user rule, shared with profile validation. */
export function assertSshUser(user: string): void {
  assertToken(user, "user");
}

/** The identity-file rule (absolute, no control characters, no dot segments), shared with profile validation. */
export function assertIdentityPath(path: string): void {
  assertAbsolutePath(path, "identityFile");
}

function assertToken(value: string, field: string): void {
  if (value.length === 0) invalid("invalid_" + field, field + " must not be empty");
  if (value.startsWith("-")) invalid("invalid_" + field, field + " must not start with -");
  if (SHELL_METACHARS.test(value)) invalid("invalid_" + field, field + " contains a disallowed character");
}

function hasDotSegment(value: string): boolean {
  return value.split("/").some((seg) => seg === "." || seg === "..");
}

function assertAbsolutePath(value: string, field: string): void {
  if (!value.startsWith("/")) invalid("invalid_" + field, field + " must be an absolute path");
  // Paths are separate argv entries, never interpolated into a shell string,
  // so spaces are safe; control characters and dot segments are rejected.
  if (/[\x00-\x1f\x7f-\x9f]/.test(value)) invalid("invalid_" + field, field + " contains a control character");
  if (hasDotSegment(value)) invalid("invalid_" + field, field + " must not contain . or .. path segments");
}

function isDevNull(path: string): boolean {
  return path.split("/").filter((s) => s.length > 0).join("/") === "dev/null";
}

/** Reject a single raw option; throws code ssh_option_rejected. */
export function assertSshOptionAllowed(option: string): void {
  if (FORBIDDEN_OPTIONS.some((re) => re.test(option))) {
    invalid("ssh_option_rejected", "ssh option rejected: " + option);
  }
  if (/^-o/.test(option)) {
    const value = option.replace(/^-o\s*/, "").trim();
    if (!ALLOWED_OPTIONS.includes(value)) {
      invalid("ssh_option_rejected", "ssh option rejected: " + option);
    }
    return;
  }
  invalid("ssh_option_rejected", "ssh option rejected: " + option);
}

/** The environment allowlist for the child process. */
export function sshEnvAllowlist(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = { TERM: "xterm-256color" };
  for (const key of ["LANG", "HOME", "USER", "PATH", "SSH_AUTH_SOCK"]) {
    const value = env[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("LC_") && value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

export function buildSshArgv(target: SshTarget, options: { allowKnownHostsFileWithSecret?: boolean } = {}): string[] {
  const argv = ["ssh", "-tt"];
  if (target.user !== undefined) {
    assertToken(target.user, "user");
    argv.push("-l", target.user);
  }
  if (target.port !== undefined) {
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      invalid("invalid_port", "port must be an integer 1..65535");
    }
    argv.push("-p", String(target.port));
  }
  if (target.authMethod !== undefined) {
    // A saved secret only ever goes to the destination named here: no user or system SSH configuration
    // (no HostName redirect, ProxyCommand, ControlMaster or extra IdentityFile). A configFile given
    // with it is ignored.
    argv.push("-F", "none");
  } else if (target.configFile !== undefined) {
    assertAbsolutePath(target.configFile, "configFile");
    argv.push("-F", target.configFile);
  }
  if (target.knownHostsFile !== undefined) {
    // A session with a saved secret reads the helper's own host-key file; the helper refuses another one. Say so
    // here, early and clearly, instead of letting the session fail later.
    if (target.authMethod !== undefined && options.allowKnownHostsFileWithSecret !== true) {
      invalid("invalid_knownHostsFile", "a session with a saved secret uses Remote Hub's own host-key file; knownHostsFile is not accepted");
    }
    assertAbsolutePath(target.knownHostsFile, "knownHostsFile");
    // ssh splits UserKnownHostsFile on whitespace into several files, and
    // /dev/null would accept any host; both must be refused for this field.
    if (/\s/.test(target.knownHostsFile)) {
      invalid("invalid_knownHostsFile", "knownHostsFile must not contain whitespace");
    }
    if (isDevNull(target.knownHostsFile)) {
      invalid("invalid_knownHostsFile", "knownHostsFile must not be /dev/null");
    }
    argv.push("-o", "UserKnownHostsFile=" + target.knownHostsFile);
  }
  if (target.identityFile !== undefined) {
    assertAbsolutePath(target.identityFile, "identityFile");
    argv.push("-i", target.identityFile, "-o", "IdentitiesOnly=yes");
  }
  if (target.authMethod !== undefined) {
    if (target.authMethod !== "password" && target.authMethod !== "publickey") invalid("invalid_authMethod", "authMethod must be password or publickey");
    argv.push("-o", "PreferredAuthentications=" + target.authMethod);
    // The passphrase of a key is for that key only: no agent identities.
    if (target.authMethod === "publickey") argv.push("-o", "IdentityAgent=none");
    // A saved secret is tried once. A second prompt is how the helper learns it was refused (it never answers it); the default of 3 would add another prompt.
    argv.push("-o", "NumberOfPasswordPrompts=2");
  }
  for (const option of target.extraOptions) {
    assertSshOptionAllowed(option);
    argv.push(option);
  }
  assertToken(target.host, "host");
  // With a saved secret the destination is the lower-case form the secret is bound to and OpenSSH prints.
  argv.push("--", target.authMethod !== undefined ? target.host.toLowerCase() : target.host);
  return argv;
}

export function buildSshSpawn(target: SshTarget, env: Record<string, string | undefined>): SshSpawnSpec {
  return {
    program: "/usr/bin/ssh",
    // Only a test-hooks helper takes a caller-chosen host-key file with a saved secret; the flag is the same one.
    argv: buildSshArgv(target, { allowKnownHostsFileWithSecret: env.REMOTE_HUB_TEST_ALLOW_KNOWN_HOSTS !== undefined }),
    env: sshEnvAllowlist(env),
  };
}
