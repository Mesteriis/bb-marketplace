import type { Scaffold } from "../../core/scaffolds/model.ts";
import { versions as v } from "../../core/scaffolds/versions.ts";

// Import specifiers are spelled through these, so this file's text never reads as an import of host code.
const sdk = "\"@get-bb/plugin-sdk\"";
const sdkApp = "\"@get-bb/plugin-sdk/app\"";
const sdkHost = "\"@get-bb/plugin-sdk/host\"";

/**
 * (tsconfig has no exactOptionalPropertyTypes: the SDK's contracts take Zod schemas, whose Standard Schema result type
 * does not satisfy the SDK's under that flag.)
 *
 * A BB plugin: package.json with its `bb` field, a server with one RPC, an optional app page and host entry, core and
 * UI kept free of host code (with the test that guards it), ESLint with typed rules, `npm run check` and `bb plugin build`.
 */
export const bbPlugin: Scaffold = {
  id: "bb-plugin",
  title: "BB plugin",
  description: "TypeScript BB plugin: server with an RPC, optional app page and host entry, core/adapters/ui layers with an architecture test, ESLint.",
  params: [
    {name: "displayName", label: "Name shown in BB", kind: "line", default: "My plugin"},
    {name: "app", label: "App page (React)", kind: "flag", default: true},
    {name: "host", label: "Host entry (runs on each machine)", kind: "flag", default: false},
    {name: "sdk", label: "BB plugin SDK version (that of your BB)", kind: "text", default: v.bbSdk, pattern: "^\\d+\\.\\d+\\.\\d+$"},
  ],
  ignore: ["node_modules/", "dist/"],
  ci: {packageManager: "npm", lockfile: false, make: true},
  files: [
    {path: "package.json", body: `{
  "name": {{name|json}},
  "version": "0.1.0",
  "private": true,
  "description": {{description|json}},
{{#license=MIT}}
  "license": "MIT",
{{/license}}
{{#license=Apache-2.0}}
  "license": "Apache-2.0",
{{/license}}
{{#license=none}}
  "license": "UNLICENSED",
{{/license}}
  "type": "module",
  "engines": {
    "bbPluginSdk": ">={{sdk}}",
    "node": ">=22.18"
  },
  "bb": {
    "name": {{displayName|json}},
    "description": {{description|json}},
    "branding": {
      "icon": "Puzzle"
    },
{{#app}}
    "app": "./app.tsx",
{{/app}}
{{#host}}
    "host": "./host.ts",
{{/host}}
    "server": "./server.ts"
  },
  "scripts": {
    "check": "tsc --noEmit && eslint . && node --test tests/*.test.ts",
    "test": "node --test tests/*.test.ts",
    "lint": "eslint .",
    "build": "bb plugin build"
  },
  "dependencies": {
    "zod": "^${v.zod}"
  },
  "devDependencies": {
    "@eslint/js": "^${v.eslintJs}",
    "@get-bb/plugin-sdk": "{{sdk}}",
    "@types/better-sqlite3": "^${v.typesBetterSqlite3}",
    "@types/node": "^22.18.0",
{{#app}}
    "@types/react": "^${v.typesReact}",
    "react": "^${v.react}",
{{/app}}
    "eslint": "^${v.eslint}",
    "globals": "^${v.globals}",
    "hono": "^${v.hono}",
    "typescript": "^${v.typescriptBb}",
    "typescript-eslint": "^${v.typescriptEslint}"
  }
}
`},
    {path: "tsconfig.json", body: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": false
  },
  "include": ["server.ts", "app.tsx", "host.ts", "src", "tests"]
}
`},
    {path: "eslint.config.js", body: `import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {ignores: ["dist", "eslint.config.js"]},
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {languageOptions: {globals: {...globals.node, ...globals.browser}, parserOptions: {projectService: true, tsconfigRootDir: import.meta.dirname}}},
  // node:test's test() returns a promise the runner awaits itself.
  {files: ["tests/**/*.ts"], rules: {"@typescript-eslint/no-floating-promises": "off"}},
);
`},
    {path: "server.ts", body: `import type { BbPluginApi } from ${sdk};
import { rpc } from "./src/adapters/bb/rpc.ts";
import { greeting } from "./src/core/greeting.ts";

export default function plugin(bb: BbPluginApi): void {
  bb.rpc.register(rpc, {
    greet: ({name}) => ({text: greeting(name)}),
  });
}
`},
    {path: "src/adapters/bb/rpc.ts", body: `import { defineRpcContract } from ${sdk};
import { z } from "zod";

/** What the app asks of the server. */
export const rpc = defineRpcContract({
  greet: {input: z.object({name: z.string().max(80)}), output: z.object({text: z.string()})},
});
`},
    {path: "src/core/greeting.ts", body: `/** The plugin's own logic stays here, free of BB and Node.js, so it is tested on its own. */
export function greeting(name: string): string {
  const trimmed = name.trim();
  return trimmed ? "Hello, " + trimmed + "!" : "Hello!";
}
`},
    {path: "app.tsx", when: "app", body: `import { definePluginApp, useRpc } from ${sdkApp};
import { useEffect, useState } from "react";
import type { rpc } from "./src/adapters/bb/rpc.ts";
import { GreetingView } from "./src/ui/greeting-view.tsx";

function Page() {
  const client = useRpc<typeof rpc>();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.call("greet", {name: "BB"}).then(result => { if (live) setText(result.text); }, () => { if (live) setText("The server did not answer."); });
    return () => { live = false; };
  }, [client]);
  return <GreetingView text={text}/>;
}

export default definePluginApp(app => {
  app.slots.navPanel({id: "main", title: {{displayName|json}}, icon: "Puzzle", path: "main", component: Page});
});
`},
    {path: "src/ui/greeting-view.tsx", when: "app", body: `/** UI without host calls: it shows what it is given. */
export function GreetingView({text}: {text: string | null}) {
  return <main>
    <h1>{{name}}</h1>
    <p role="status">{text ?? "Loading…"}</p>
  </main>;
}
`},
    {path: "host.ts", when: "host", body: `import { experimental_defineHostEntry } from ${sdkHost};
import { hostname } from ${"\"node:os\""};
import { hostContract } from "./src/adapters/bb/host-contract.ts";

/** Runs on each machine BB reaches; the server calls it through bb.hosts. */
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    machine: () => ({name: hostname()}),
  },
});
`},
    {path: "src/adapters/bb/host-contract.ts", when: "host", body: `import { defineRpcContract } from ${sdk};
import { z } from "zod";

/** What the server asks of a machine. */
export const hostContract = defineRpcContract({
  machine: {input: z.object({}), output: z.object({name: z.string()})},
});
`},
    {path: "tests/greeting.test.ts", body: `import assert from "node:assert/strict";
import { test } from "node:test";
import { greeting } from "../src/core/greeting.ts";

test("a name is greeted by name, a blank one without", () => {
  assert.equal(greeting(" Ada "), "Hello, Ada!");
  assert.equal(greeting("  "), "Hello!");
});
`},
    {path: "tests/architecture.test.ts", body: `import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// src/core and src/ui hold no host code: BB's SDK, Node.js, Electron and Tauri stay in src/adapters and the entries.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forbidden = /^(?:node:|@get-bb\\/|electron|@tauri-apps\\/)/;
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\\.tsx?$/.test(name) ? [path] : [];
});
const specifiers = (source: string) => [...source.matchAll(/(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)["']([^"']+)["']/g)].map(match => match[1] ?? "");

for (const layer of ["core", "ui"]) {
  test("src/" + layer + " imports no host code", () => {
    let base: string;
    try { base = join(root, "src", layer); statSync(base); } catch { return; }
    const found = files(base).flatMap(file => specifiers(readFileSync(file, "utf8"))
      .filter(spec => forbidden.test(spec)).map(spec => relative(root, file) + " → " + spec));
    assert.deepEqual(found, []);
  });
}
`},
    {path: "Makefile", body: `.PHONY: check test build

check:
\tnpm run check

test:
\tnpm test

build:
\tnpm run build
`},
    {path: "PLUGIN_OVERVIEW.md", body: `## {{displayName}}

{{description}}
`},
    {path: "AGENTS.md", body: `# Instructions for coding agents

{{description}}

## Commands

- \`npm run check\` — types, ESLint and tests. Run it after every change; CI runs it through \`make check\`.
- \`npm run build\` — \`bb plugin build\`. Run it before calling a change done.

## Rules

- \`src/core\` and \`src/ui\` stay free of host code: no BB SDK, Node.js, Electron or Tauri imports there, and
  \`tests/architecture.test.ts\` is not weakened to let one pass. Add a port in the core and an adapter in
  \`src/adapters/bb\` instead.
- Use the installed SDK declarations as the API contract (\`node_modules/@get-bb/plugin-sdk\`).
- \`bb.description\` in package.json and PLUGIN_OVERVIEW.md describe current behaviour and change together.
- Record third-party code or assets in \`THIRD_PARTY_NOTICES.md\` in the same change.
`},
    {path: "README.md", body: `# {{displayName}}

{{description}}

## Development

- \`bb plugin types\` — aligns the SDK pin with your BB, if it differs; then \`npm install\`, which writes
  \`package-lock.json\` (commit it).
- \`npm run check\` — TypeScript, ESLint and tests.
- \`npm run build\` — builds the plugin with \`bb plugin build\`; install it in BB from this folder.
`},
  ],
};
