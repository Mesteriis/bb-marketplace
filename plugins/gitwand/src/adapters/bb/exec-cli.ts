// Runs a forge CLI with an execFile-style function (BB's
// experimental_execHostFileCallback in the server) and turns every outcome
// into an exit code: failures never throw and never carry an error message
// built from the command line.
import type { Exec } from "./forge-cli.ts";

type ExecFileLike = (
  cmd: string,
  args: string[],
  options: { encoding: "utf8"; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean },
  callback: (error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null, stdout: string, stderr: string) => void,
) => unknown;

const MAX_OUTPUT = 64 * 1024 * 1024;

export function execCli(execFile: ExecFileLike): Exec {
  return (cmd, args, { env, timeoutMs }) =>
    new Promise((resolve) => {
      execFile(cmd, args, { encoding: "utf8", env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true }, (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr, timedOut: false });
        const timedOut = error.killed === true && error.signal != null;
        const code = typeof error.code === "number" ? error.code : error.code === "ENOENT" ? 127 : 1;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", timedOut });
      });
    });
}
