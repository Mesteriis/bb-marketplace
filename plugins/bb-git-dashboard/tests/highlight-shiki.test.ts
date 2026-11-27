import assert from "node:assert/strict";
import { test } from "node:test";
import { grammarRoute } from "../src/adapters/bb/grammar-route.ts";
import { tokenize, type CodeTheme } from "../src/ui/highlight/shiki.ts";

const theme = (keyword: string): CodeTheme => ({name: "stand", type: "dark", fg: "#cccccc", bg: "#111111", colors: {},
  tokenColors: [{settings: {foreground: "#cccccc"}}, {scope: ["keyword", "storage.type"], settings: {foreground: keyword, fontStyle: "italic"}}]});
// The grammar as the app gets it: through the server's route, as JSON.
const grammar = async (id: string) => (await grammarRoute()({req: {query: () => id}})).json();

test("a line is painted with BB's theme document and the grammar of its file, its text unchanged", async () => {
  const [line] = await tokenize("const a = 1;", "typescript", theme("#ff0000"), grammar);
  assert.equal(line.map(token => token.content).join(""), "const a = 1;");
  const keyword = line.find(token => token.content === "const");
  assert.deepEqual([keyword?.color?.toLowerCase(), keyword?.fontStyle], ["#ff0000", 1]);
});

test("a new theme document repaints; the grammar is fetched once per language", async () => {
  let fetched = 0;
  const counted = async (id: string) => { fetched++; return grammar(id); };
  await tokenize("x = 1", "python", theme("#ff0000"), counted);
  const [line] = await tokenize("def f(): pass", "python", theme("#00ff00"), counted);
  assert.equal(line.find(token => token.content === "def")?.color?.toLowerCase(), "#00ff00");
  assert.equal(fetched, 1);
});

test("a grammar that cannot be fetched rejects, and is asked for again next time", async () => {
  let calls = 0;
  const failing = async () => { calls++; throw new Error("offline"); };
  await assert.rejects(tokenize("a", "go", theme("#ff0000"), failing));
  await assert.rejects(tokenize("a", "go", theme("#ff0000"), failing));
  assert.equal(calls, 2);
});
