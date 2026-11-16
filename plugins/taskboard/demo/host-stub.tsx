// Minimal stand-in for BB's @get-bb/plugin-sdk/app host shim, used ONLY by the
// standalone demo build. It provides the one symbol the vendored design system
// needs (experimental_Icon). It is not part of the shipped plugin.
import { createElement } from "react";

export function experimental_Icon({ name, ...rest }: { name?: string; [key: string]: unknown }) {
  return createElement("span", { "data-icon-root": "", "aria-hidden": "true", ...rest }, name ?? "");
}
