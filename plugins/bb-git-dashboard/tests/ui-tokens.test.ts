import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contrast, hexToOklch, type Oklch } from "./support/color.ts";

const read = (path: string) => readFileSync(new URL("../src/ui/" + path, import.meta.url), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = strip(read("system/tokens.css"));
const system = strip(read("system/system.css"));
const shell = strip(read("shell/shell.css"));
const bbTokens = new Set(["--background", "--foreground", "--muted-foreground", "--border", "--accent", "--card", "--primary",
  "--primary-foreground", "--destructive", "--ring", "--font-mono"]);

// Background and text of every palette BB ships, light and dark, read from the app's stylesheet (BB 0.50).
// Default is achromatic; the others are coloured, from the lighter dark ones (nord, dracula) to the tinted light ones.
const palettes: [string, Oklch, Oklch][] = [
  ["default light", {l: 1, c: 0, h: 0}, {l: 0.3211, c: 0, h: 0}], ["default dark", {l: 0.195, c: 0, h: 0}, {l: 0.81, c: 0, h: 0}],
  ...([["catppuccin light", "#eff1f5", "#4c4f69"], ["catppuccin dark", "#1e1e2e", "#cdd6f4"], ["dracula light", "#f8f8f2", "#282a36"],
    ["dracula dark", "#282a36", "#f8f8f2"], ["gruvbox light", "#fbf1c7", "#3c3836"], ["gruvbox dark", "#282828", "#ebdbb2"],
    ["nord light", "#eceff4", "#2e3440"], ["nord dark", "#2e3440", "#d8dee9"], ["solarized light", "#fdf6e3", "#073642"],
    ["solarized dark", "#002b36", "#93a1a1"]] as const).map(([name, bg, fg]) => [name, hexToOklch(bg), hexToOklch(fg)] as [string, Oklch, Oklch]),
];

/** The value of a custom property in tokens.css. */
function declared(name: string): string {
  const match = tokens.match(new RegExp("\\s" + name + ":\\s*([^;]+);"));
  assert.ok(match, name + " is declared");
  return match[1]!.trim();
}

/** Evaluates `oklch(from var(--background) L C H)` of a token for a background, as the browser does. */
function resolve(name: string, background: Oklch): Oklch {
  const value = declared(name).replaceAll("var(--git-step)", "(" + declared("--git-step") + ")");
  const match = value.match(/^oklch\(from var\(--background\) (.+)\)$/);
  assert.ok(match, name + " is a colour relative to --background");
  const channels: string[] = [];
  let depth = 0, current = "";
  for (const char of match[1]!) {
    if (char === " " && depth === 0) { if (current) channels.push(current); current = ""; continue; }
    if (char === "(") depth++;
    if (char === ")") depth--;
    current += char;
  }
  channels.push(current);
  assert.equal(channels.length, 3, name + " has three channels");
  const evaluate = (expression: string) => {
    const js = expression.replace(/\bcalc\(/g, "(").replace(/\bclamp\(/g, "clamp(");
    assert.match(js, /^[\d\s.+\-*/(),lchminaxp]+$/, "only arithmetic in " + name);
    return Function("l", "c", "h", "min", "max", "clamp", "return " + js)(background.l, background.c, background.h, Math.min, Math.max,
      (low: number, value: number, high: number) => Math.min(Math.max(low, value), high)) as number;
  };
  const [l, c, h] = channels.map(evaluate) as [number, number, number];
  return {l: Math.min(1, Math.max(0, l)), c: Math.max(0, c), h};
}

test("the plugin's CSS uses BB's theme tokens and its own --git-* only, with no theme of its own", () => {
  for (const [file, css] of [["tokens.css", tokens], ["system.css", system], ["shell.css", shell]] as const) {
    for (const [, name] of css.matchAll(/var\((--[\w-]+)/g)) {
      assert.ok(bbTokens.has(name!) || name!.startsWith("--git-"), file + " uses " + name);
    }
    assert.doesNotMatch(css, /prefers-color-scheme/, file);
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![\w-])(white|black)(?![\w-])/i, file + " has no literal colours");
    for (const [mix] of css.matchAll(/color-mix\(in \w+/g)) assert.equal(mix, "color-mix(in oklab", file + ": " + mix);
  }
  for (const [mix] of tokens.matchAll(/oklch\([^f]/g)) assert.fail("an absolute oklch() in tokens.css: " + mix);
});

test("every status colour reads at 4.5:1 on the page and on its own tone, in every BB palette", () => {
  const pairs = [["--git-bad-text", "--git-bad-bg"], ["--git-success", "--git-good-bg"], ["--git-warning", "--git-warn-bg"],
    ["--git-violet", "--git-violet-bg"]] as const;
  const failures: string[] = [];
  for (const [palette, background] of palettes) {
    for (const [text, tone] of pairs) {
      const colour = resolve(text, background);
      const onPage = contrast(colour, background);
      const onTone = contrast(colour, resolve(tone, background));
      if (onPage < 4.5) failures.push(palette + " " + text + " on the page " + onPage.toFixed(2));
      if (onTone < 4.5) failures.push(palette + " " + text + " on " + tone + " " + onTone.toFixed(2));
    }
  }
  assert.deepEqual(failures, []);
});

test("a tone stays a tone: near the page's lightness and on its own hue, in every palette", () => {
  for (const [palette, background] of palettes) {
    for (const [tone, hue] of [["--git-bad-bg", 25], ["--git-good-bg", 155], ["--git-warn-bg", 50], ["--git-violet-bg", 291.6]] as const) {
      const value = resolve(tone, background);
      assert.ok(Math.abs(value.l - background.l) < 0.12, palette + " " + tone + " stays near the page lightness");
      assert.ok(value.c > background.c || value.c > 0.01, palette + " " + tone + " carries its colour");
      assert.equal(value.h, hue, palette + " " + tone + " keeps its hue");
    }
  }
});

test("the theme's own text stays readable on every tone", () => {
  const failures: string[] = [];
  for (const [palette, background, ink] of palettes) {
    const base = contrast(ink, background);
    for (const tone of ["--git-bad-bg", "--git-good-bg", "--git-warn-bg", "--git-violet-bg"]) {
      const ratio = contrast(ink, resolve(tone, background));
      // A tone may cost the text at most a fifth of the contrast it has on the page.
      if (ratio < Math.min(4.5, base * 0.8)) failures.push(palette + " text on " + tone + " " + ratio.toFixed(2) + " of " + base.toFixed(2));
    }
  }
  assert.deepEqual(failures, []);
});
