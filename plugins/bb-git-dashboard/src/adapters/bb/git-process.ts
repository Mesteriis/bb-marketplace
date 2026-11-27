import { spawn } from "node:child_process";

export type GitRun = (args: string[], options?: {input?: string; index?: string; codes?: number[]; author?:{name:string;email:string};
  /** The committer alone, so a rebase keeps each replayed commit's author. */
  committer?: {name: string; email: string};
  /** Output cap in bytes; 512 KiB unless a read needs more (refs and status of large repositories). */
  limit?: number;
  /** Past the cap, keep the output up to its last whole line and mark it truncated instead of failing. */
  truncate?: boolean;
  /** How long the command may run, 25 s unless it replays commits (a merge or rebase of a large branch). */
  timeout?: number}) => Promise<{text: string; code: number; truncated?: boolean}>;

export function gitRunner(root: string, signal?: AbortSignal, transport?: {username: string; helper: string}): GitRun {
  return (args, options = {}) => new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot,
      LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1",
      GIT_NO_REPLACE_OBJECTS: "1", GIT_INDEX_FILE: options.index,
      GIT_AUTHOR_NAME:options.author?.name, GIT_AUTHOR_EMAIL:options.author?.email,
      GIT_COMMITTER_NAME:(options.committer ?? options.author)?.name, GIT_COMMITTER_EMAIL:(options.committer ?? options.author)?.email,
      // No command ever waits for an editor: merge and rebase take their prepared messages and plans as they are.
      GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no",
    };
    const git = spawn("git", [
      "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "-c", "commit.gpgSign=false", "-c", "core.useBuiltinFSMonitor=false",
      "-c", "core.untrackedCache=false",
      "-c", "maintenance.auto=false", "-c", "gc.auto=0",
      "-c", "protocol.allow=never",
      ...(transport ? [
        "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false",
        "-c", "http.sslVerify=true", "-c", "credential.helper=",
        "-c", "credential.helper=" + transport.helper, "-c", "credential.useHttpPath=true",
        "-c", "credential.username=" + transport.username,
      ] : ["-c", "protocol.file.allow=always"]),
      "-c", "submodule.recurse=false", "--no-pager", ...args,
    ], {
      cwd: root, env, signal: AbortSignal.any([AbortSignal.timeout(options.timeout ?? 25_000), ...(signal ? [signal] : [])]),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    const limit = options.limit ?? 512 * 1024;
    git.stdout.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        if (options.truncate) chunks.push(chunk.subarray(0, chunk.length - (size - limit)));
        git.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    git.stdin.on("error", () => {/* Process termination is reported via close. */});
    git.stdin.end(options.input);
    git.on("error", (error: NodeJS.ErrnoException) => reject(new Error(error.code === "ABORT_ERR" ? "GIT_RESULT_UNKNOWN" : "GIT_PROCESS_UNAVAILABLE")));
    git.on("close", code => {
      if (tooLarge && options.truncate) {
        const bytes = Buffer.concat(chunks);
        // A newline byte never sits inside a UTF-8 sequence, so cutting after it keeps the text decodable.
        const whole = bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
        try { resolve({text: new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(whole), code: 0, truncated: true}); }
        catch { reject(new Error("GIT_UNSUPPORTED_ENCODING")); }
      } else if (tooLarge) reject(new Error("GIT_OUTPUT_LIMIT"));
      else if (code !== null && (options.codes ?? [0]).includes(code)) {
        const bytes = Buffer.concat(chunks);
        try {
          resolve({text: new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes), code});
        } catch {
          reject(new Error("GIT_UNSUPPORTED_ENCODING"));
        }
      } else reject(new Error(code === null ? "GIT_RESULT_UNKNOWN" : "GIT_REJECTED"));
    });
  });
}
