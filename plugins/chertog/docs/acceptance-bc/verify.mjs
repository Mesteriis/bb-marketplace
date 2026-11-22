// Run from any directory. Check the evidence, including failures and built-in skips.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = name => readFileSync(new URL(name, import.meta.url), "utf8");
const gates = JSON.parse(read("gates.json"));
assert.match(gates.revision, /^[0-9a-f]{40}$/);
for (const name of ["chertog", "telegram", "zoom", "remote-hub"]) {
  for (const command of ["check", "build"]) {
    const gate = gates.commands.find(entry => entry.package === name && entry.command === "npm run " + command);
    assert(gate, name + " " + command);
    const output = read(gate.log);
    assert.equal(gate.exit, 0, name + " " + command);
    assert.match(output, command === "check" ? /Tests\s+\d+ passed/ : /dist\/app\.js/);
  }
}
const manifests = gates.commands.find(entry => entry.command === "node scripts/check-manifests.mjs");
assert.equal(manifests.exit, 0);
assert.match(read(manifests.log), /manifests ok: 85 plugin\(s\), 85 catalog entry\(ies\)/);
const extended = gates.additional_checks.find(entry => entry.command.includes("--testTimeout 20000"));
assert.equal(extended.exit, 0);
assert.match(read(extended.log), /Tests\s+1829 passed.*4 skipped/);
const browser = read("browser.txt");
for (const check of ["PASS Home redirect", "PASS live two-revision diff",
  "PASS Команда агентов after reload", "PASS Администрирование after reload", "PASS Созвон after reload",
  "PASS Zoom invitation, SSH xterm, ready RDP and VNC", "PASS explicit synthetic Zoom join", "PASS immediate drop: both DOMRects equal, no send/upload",
  "PASS disabled detach menu", "Переместите целое окно BB", "PASS closed receiver restored the source"]) {
  assert(browser.includes(check), check);
}
const table = read("../acceptance-bc.md");
for (const row of ["Drop файла в Telegram", "Меню панели без отстыковки"]) {
  assert(table.split("\n").some(line => line.startsWith("| " + row + " |") && line.includes("acceptance-bc/browser.txt")));
}
console.log("PASS 9 command records, separate Telegram 20s result, A/B/C browser observations, immediate Telegram drop and unsupported detach menu");
