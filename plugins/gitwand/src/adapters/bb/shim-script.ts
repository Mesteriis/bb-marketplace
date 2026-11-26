// The script GitWand's index.html loads first: the shim as plain JavaScript
// (generated from src/shim/tauri-shim.ts, so the plugin bundler never touches
// its inside), called with the relay base.
import { SHIM_SOURCE } from "./shim-source.generated.ts";

export function shimScript(base: string): string {
  const config = JSON.stringify({ base }).replace(/</g, "\\u003c");
  return `(function () {\n"use strict";\n${SHIM_SOURCE}\ninstallTauriShim(window, ${config});\n})();\n`;
}
