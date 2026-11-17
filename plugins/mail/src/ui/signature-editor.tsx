// The signature editor (slice 3d): the composer's editor with bold, italic,
// underline and links only. Lists and quotes are off, so what the owner
// writes is paragraphs, as the server keeps a signature. Save hands the
// document back (null when it is empty); the host calls identity_update.
import { useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { ComposeEditor, type EditorDoc } from "./compose-editor.tsx";
import { ComposeToolbar, type ToolId } from "./compose-toolbar.tsx";
import { tx } from "./i18n/index.ts";

/** The signature editor's tools: marks and links, no lists, no quotes. */
export const SIGNATURE_TOOLS: readonly ToolId[] = ["bold", "italic", "underline", "link"];

const EMPTY_DOC: EditorDoc = { type: "doc", content: [{ type: "paragraph" }] };

/** True when the document holds no visible text. */
export function editorDocEmpty(doc: EditorDoc): boolean {
  const walk = (node: EditorDoc): boolean => (node.text ?? "").trim() === "" && (node.content ?? []).every(walk);
  return walk(doc);
}

export interface SignatureEditorProps {
  /** The address the signature belongs to, for the editor's label. */
  address: string;
  /** The stored signature document, or null for none. */
  initial: EditorDoc | null;
  /** Saves the signature; null clears it. Rejects with the server's text. */
  onSave: (doc: EditorDoc | null) => Promise<void>;
  onCancel: () => void;
}

export function SignatureEditor({ address, initial, onSave, onCancel }: SignatureEditorProps) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const doc = useRef<EditorDoc>(initial ?? EMPTY_DOC);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await onSave(editorDocEmpty(doc.current) ? null : doc.current);
    } catch (error) {
      setProblem(error instanceof Error && error.message ? error.message : "Could not save the signature.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-background">
      <div className="border-b border-border px-2 py-1">
        <ComposeToolbar
          editor={editor}
          linkOpen={linkOpen}
          onLinkOpenChange={setLinkOpen}
          tools={SIGNATURE_TOOLS}
        />
      </div>
      <ComposeEditor
        label={tx("Signature for {address}", { address })}
        initialDoc={initial ?? EMPTY_DOC}
        importFrom={null}
        features={{ lists: false, quotes: false, code: false }}
        onChange={(next) => {
          doc.current = next;
          setProblem(null);
        }}
        onFiles={() => setProblem("A signature cannot hold files.")}
        onReady={setEditor}
        onLinkShortcut={() => setLinkOpen(true)}
      />
      {problem !== null ? (
        <p role="alert" className="px-3 text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 border-t border-border px-2 py-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {tx("Cancel")}
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={busy}>
          {tx("Save signature")}
        </Button>
      </div>
    </div>
  );
}
