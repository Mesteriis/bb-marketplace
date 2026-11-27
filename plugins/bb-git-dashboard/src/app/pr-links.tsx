import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef } from "react";
import type { rpc } from "../adapters/bb/rpc.ts";
import { linkTarget } from "../core/pulls/pr-link.ts";
import { refPath } from "../ui/review/review-api.ts";

type Account = {kind: string; id: string; origin: string};

/**
 * A plain click on a github.com pull request link anywhere in BB opens it in Makosh Git (ported from
 * bb-github-pr-dashboard's PrLinkListener). BB has no hook for links, so this reads clicks on real `<a href>` anchors
 * in the capture phase; controls that open a URL without an anchor still go to GitHub. Makosh Git's own pages, a
 * modified click and a link that says it goes to the forge are left alone.
 */
export function PrLinkOverlay() {
  const navigate = useBbNavigate();
  const client = useRpc<typeof rpc>();
  // Read once and on focus: the click handler must decide at once, before BB's own handlers open the link.
  const accounts = useRef<Account[]>([]);
  useEffect(() => {
    const read = () => { client.call("accounts").then(result => { if (result.ok) accounts.current = result.items; }, () => {}); };
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [client]);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.closest(".git-ws")) return;
      if (/\bon (github|the forge)\b/i.test(anchor.getAttribute("aria-label") ?? anchor.textContent ?? "")) return;
      const target = linkTarget(anchor.href, accounts.current);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      navigate.toPluginPanel("git", {subPath: refPath("pr", target)});
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [navigate]);
  return null;
}
