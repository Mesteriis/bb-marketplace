// Chertog's own way to the new thread screen. BB shows that screen and the
// stock Home on one route, so the action leaves a pass for the redirect.
import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import { createNewThreadPass } from "../../../core/home/index.ts";

/** This window's pass. Kept in memory: a reload or another window starts without one. */
export const newThreadPass = createNewThreadPass();

/**
 * Let the next arrival on the new thread screen through without a redirect.
 * Call it immediately before navigating there; the pass is spent by that
 * arrival and expires on its own if the navigation never happens.
 */
export function allowNextNewThreadScreen(now: number = Date.now()): void {
  newThreadPass.grant(now);
}

/** Open BB's new thread screen from Chertog: the pass first, then the navigation. */
export function openNewThreadScreen(
  navigate: Pick<BbNavigate, "toCompose">,
  options?: Parameters<BbNavigate["toCompose"]>[0],
): void {
  allowNextNewThreadScreen();
  navigate.toCompose(options);
}
