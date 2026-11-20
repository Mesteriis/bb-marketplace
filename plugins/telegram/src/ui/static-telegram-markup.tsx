import { createElement, useMemo, type ReactNode } from "react";

const staticEmbedTags = new Set(["article", "section", "figure", "figcaption", "div", "span", "p",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "strong", "b", "em", "i",
  "u", "s", "del", "sup", "sub", "small", "mark", "bdi", "br", "hr", "ul", "ol", "li",
  "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td"]);
const staticEmbedIgnored = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "form"]);

function readStaticMarkup(html: string) {
  // Template contents stay inert. Only newly created, allowlisted React elements reach the page.
  const template = document.createElement("template");
  template.innerHTML = html;
  let remaining = 800;
  let hasText = false;
  function render(node: Node, key: number, depth: number): ReactNode {
    if (--remaining < 0 || depth > 24) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent?.trim()) hasText = true;
      return node.textContent;
    }
    if (!(node instanceof Element) || node.namespaceURI !== "http://www.w3.org/1999/xhtml"
      || staticEmbedIgnored.has(node.localName)) return null;
    const children = Array.from(node.childNodes, (child, index) => render(child, index, depth + 1));
    const tag = staticEmbedTags.has(node.localName) ? node.localName : "span";
    const props = { key, ...(tag === "td" || tag === "th" ? {
      rowSpan: Math.min(30, Math.max(1, Number.parseInt(node.getAttribute("rowspan") ?? "", 10) || 1)),
      colSpan: Math.min(20, Math.max(1, Number.parseInt(node.getAttribute("colspan") ?? "", 10) || 1)),
    } : {}) };
    return createElement(tag, props, tag === "br" || tag === "hr" ? undefined : children);
  }
  const nodes = Array.from(template.content.childNodes, (node, index) => render(node, index, 0));
  return { nodes, hasText };
}

export function StaticTelegramMarkup({ html, className, empty }: { html: string; className?: string; empty?: ReactNode }) {
  const { nodes, hasText } = useMemo(() => readStaticMarkup(html), [html]);
  return empty && !hasText ? <>{empty}</> : <div className={className}>{nodes}</div>;
}
