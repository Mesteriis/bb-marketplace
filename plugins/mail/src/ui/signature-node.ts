// The signature block in the composer's editor (slice 3d): a top-level node
// of paragraphs, `div.makosh-signature` in HTML, as the server keeps it.
// It is in no group, so no list item or quote can hold it, and the
// document's content becomes `(block | signature)+` (spec resolution 17).
// It is isolating and defining: typing, joins and pastes stay on their side
// of its edge. A draft that had a signature keeps the block: an edit that
// removes it (select all and type, a delete across it) leaves an empty one
// where it was, the placeholder a change of From fills in later. The muted
// `-- ` marker is drawn by CSS only when the block is the last one (spec
// resolution 2) and an empty block draws nothing.
import { Node } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";

/** The fixed class of the signature's `div` (core compose-doc SIGNATURE_CLASS). */
export const SIGNATURE_CLASS = "makosh-signature";
/** Transaction meta: this change may remove the signature (a load, not an edit). */
export const SIGNATURE_REPLACE_META = "makoshSignatureReplace";

/** The top-level signature's position and node, or null. */
export function findSignature(doc: PmNode): { pos: number; node: PmNode } | null {
  let found: { pos: number; node: PmNode } | null = null;
  doc.forEach((child, offset) => {
    if (found === null && child.type.name === "signature") found = { pos: offset, node: child };
  });
  return found;
}

const keepKey = new PluginKey("makoshSignatureKeep");

export const SignatureNode = Node.create({
  name: "signature",
  content: "paragraph*",
  isolating: true,
  defining: true,
  selectable: false,
  draggable: false,

  parseHTML() {
    return [{ tag: `div.${SIGNATURE_CLASS}` }];
  },

  renderHTML() {
    return ["div", { class: SIGNATURE_CLASS }, 0];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: keepKey,
        appendTransaction: (transactions: readonly Transaction[], oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (transactions.some((tr) => tr.getMeta(SIGNATURE_REPLACE_META) === true)) return null;
          const before = findSignature(oldState.doc);
          if (before === null || findSignature(newState.doc) !== null) return null;
          const type = newState.schema.nodes.signature;
          const paragraph = newState.schema.nodes.paragraph;
          if (type === undefined || paragraph === undefined) return null;
          // After whatever replaced it: select all and type leaves it below the new text.
          const mapped = transactions.reduce((pos, tr) => tr.mapping.map(pos, 1), before.pos);
          const $pos = newState.doc.resolve(Math.min(mapped, newState.doc.content.size));
          const at = $pos.depth === 0 ? $pos.pos : $pos.after(1);
          const tr = newState.tr.insert(at, type.create());
          // The owner always has a paragraph to write in above it.
          if (tr.doc.firstChild?.type === type) tr.insert(0, paragraph.create());
          return tr;
        },
      }),
    ];
  },
});

/** The editor's document: blocks and the one signature, at the top level only. */
export const SignatureDocument = Node.create({
  name: "doc",
  topNode: true,
  content: "(block | signature)+",
});

/** Strips the signature class from untrusted HTML, so a copied signature pastes as paragraphs. */
export function withoutSignatureClass(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll(`.${SIGNATURE_CLASS}`))) {
    element.classList.remove(SIGNATURE_CLASS);
    if (element.getAttribute("class") === "") element.removeAttribute("class");
  }
}

/**
 * Normalized content of signature paragraphs for comparison: text, mark
 * types, link hrefs and hard breaks, nothing the editor adds on its own
 * (empty attributes, a link's target).
 */
export function signatureKey(paragraphs: readonly unknown[] | undefined): string {
  type Json = { type?: string; text?: string; content?: Json[]; marks?: { type?: string; attrs?: { href?: unknown } }[] };
  const inline = (node: Json) =>
    node.type === "hardBreak"
      ? ["br"]
      : [
          node.text ?? "",
          (node.marks ?? [])
            .map((mark) => (mark.type === "link" ? `link:${String(mark.attrs?.href ?? "")}` : String(mark.type)))
            .sort(),
        ];
  return JSON.stringify(
    ((paragraphs ?? []) as Json[])
      .map((p) => (p.content ?? []).map(inline))
      // Empty trailing paragraphs are not a difference.
      .filter((p, index, all) => p.length > 0 || all.slice(index).some((rest) => rest.length > 0)),
  );
}
