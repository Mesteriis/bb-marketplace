// Opens a page of this BB server in the machine's default browser. BB's own
// windows cannot use the camera or capture the screen, so a call that needs
// them runs there. Only loopback addresses are opened.
import { execFile } from "node:child_process";

type Run = (command: string, args: string[]) => Promise<void>;

const runCommand: Run = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error) => (error === null ? resolve() : reject(error)));
  });

function isLoopback(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch {
    return false;
  }
}

/** True when the browser was asked to open the page. */
export async function openInSystemBrowser(url: string, platform: string = process.platform, run: Run = runCommand): Promise<boolean> {
  if (!isLoopback(url)) return false;
  const opener = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : null;
  if (opener === null) return false;
  try {
    await run(opener, [url]);
    return true;
  } catch {
    return false;
  }
}
