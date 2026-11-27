// Stand-in for git-credential-osxkeychain on the stand (run.sh puts it in place of the real helper): Git's store and
// erase requests are appended to <log> as JSON lines, and a get is answered from them by protocol, host, path and user,
// as the Keychain helper with credential.useHttpPath does. No Keychain is touched, so no macOS dialog can appear.
// Usage (by Git): fake-credential-helper.mjs <log> get|store|erase   with the credential fields on stdin.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [log, action] = process.argv.slice(2);
const input = readFileSync(0, "utf8");
const fields = Object.fromEntries(input.split("\n").filter(line => line.includes("=")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const key = ["protocol", "host", "path", "username"].map(name => fields[name] ?? "").join("|");
if (action === "store" || action === "erase") appendFileSync(log, JSON.stringify({action, key, fields}) + "\n");
if (action === "get") {
  appendFileSync(log, JSON.stringify({action, key}) + "\n");
  let password = null;
  for (const line of existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) {
    const entry = JSON.parse(line);
    if (entry.key === key && entry.action === "store") password = entry.fields.password;
    if (entry.key === key && entry.action === "erase") password = null;
  }
  if (password !== null) process.stdout.write("password=" + password + "\n");
}
