import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type SshRun = (args: string[]) => Promise<string>;
const alias = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

const runSsh: SshRun = async args => (await promisify(execFile)("ssh", args, {
  timeout: 5_000, maxBuffer: 256 * 1024, env: {PATH: process.env.PATH, HOME: process.env.HOME},
})).stdout;

/** Resolves an SSH host alias with `ssh -G`. Only the `hostname` key leaves this function. */
export async function sshHostname(name: string, run: SshRun = runSsh) {
  if (!alias.test(name)) throw new Error("INVALID_INPUT");
  let output: string;
  try { output = await run(["-G", "--", name]); } catch { throw new Error("SSH_CONFIG_UNAVAILABLE"); }
  const line = output.split("\n").find(row => row.startsWith("hostname "));
  const value = line?.slice("hostname ".length).trim() ?? "";
  if (!alias.test(value)) throw new Error("SSH_CONFIG_UNAVAILABLE");
  return value;
}
