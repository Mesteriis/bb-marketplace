import { useId, useState, type FormEvent } from "react";
import type { Editor } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { ComposeEditor, type EditorDoc } from "../compose-editor.tsx";
import { ComposeToolbar } from "../compose-toolbar.tsx";
import { editorDocEmpty } from "../signature-editor.tsx";
import { tx } from "../i18n/index.ts";
import { type TemplateView, TEMPLATE_TOOLS, type MailSettingsProps, messageOf, docPreview } from "./shared.ts";
import { SectionHeading } from "./primitives.tsx";

type TemplateEdit = { id: string | null; name: string; doc: EditorDoc };

export function TemplatesSection({
  templates,
  onSave,
  onDelete,
}: {
  templates: readonly TemplateView[];
  onSave: MailSettingsProps["onSaveTemplate"];
  onDelete: MailSettingsProps["onDeleteTemplate"];
}) {
  const [editing, setEditing] = useState<TemplateEdit | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <SectionHeading
        action={
          editing === null ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => {
                setProblem(null);
                setEditing({ id: null, name: "", doc: { type: "doc", content: [{ type: "paragraph" }] } });
              }}
            >
              <Icon name="Plus" aria-hidden />
              {tx("New template")}
            </Button>
          ) : null
        }
      >
        {tx("Templates")}
      </SectionHeading>
      {editing !== null ? (
        <TemplateEditor
          key={editing.id ?? "new"}
          edit={editing}
          onSave={async (input) => {
            await onSave(input);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {templates.length === 0 && editing === null ? (
        <p className="text-sm text-muted-foreground">{tx("No templates yet. A template is inserted at the cursor.")}</p>
      ) : null}
      {templates.length > 0 ? (
        <ul aria-label={tx("Templates")} className="flex flex-col divide-y divide-border rounded-md border border-border">
          {templates.map((template) => (
            <li key={template.id} aria-label={template.name} className="flex flex-col gap-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{template.name}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  aria-label={tx("Edit {name}", { name: template.name })}
                  onClick={() => {
                    setProblem(null);
                    setEditing({ id: template.id, name: template.name, doc: template.doc });
                  }}
                >
                  {tx("Edit")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  aria-label={tx("Delete {name}", { name: template.name })}
                  onClick={() => setRemoving(template.id)}
                >
                  {tx("Delete")}
                </Button>
              </div>
              <p className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{docPreview(template.doc)}</p>
              {removing === template.id ? (
                <div role="alertdialog" aria-label={tx("Delete {name}", { name: template.name })} className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 text-xs text-foreground">{tx("Delete this template?")}</p>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7"
                    onClick={() => {
                      setProblem(null);
                      onDelete(template.id).then(
                        () => setRemoving(null),
                        (error: unknown) => setProblem(messageOf(error, "Could not delete the template.")),
                      );
                    }}
                  >
                    {tx("Delete")}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => setRemoving(null)}>
                    {tx("Cancel")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {problem !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function TemplateEditor({
  edit,
  onSave,
  onCancel,
}: {
  edit: TemplateEdit;
  onSave: MailSettingsProps["onSaveTemplate"];
  onCancel: () => void;
}) {
  const id = useId();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [name, setName] = useState(edit.name);
  const [doc, setDoc] = useState<EditorDoc>(edit.doc);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return setProblem("Give the template a name.");
    if (editorDocEmpty(doc)) return setProblem("Write the template's text.");
    setBusy(true);
    setProblem(null);
    try {
      await onSave({ ...(edit.id !== null ? { id: edit.id } : {}), name: name.trim(), doc });
    } catch (error) {
      setProblem(messageOf(error, "Could not save the template."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void save(event)}
      aria-label={edit.id === null ? tx("New template") : tx("Edit {name}", { name: edit.name })}
      className="flex flex-col gap-2 rounded-md border border-border p-2"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-name`} className="text-xs text-muted-foreground">
          {tx("Name")}
        </label>
        <Input
          id={`${id}-name`}
          autoFocus
          value={name}
          maxLength={80}
          onChange={(event) => {
            setName(event.target.value.replace(/[\r\n]+/g, " "));
            setProblem(null);
          }}
          className="h-8"
        />
      </div>
      <div className="rounded-md border border-border">
        <div className="border-b border-border px-2 py-1">
          <ComposeToolbar editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} tools={TEMPLATE_TOOLS} />
        </div>
        <ComposeEditor
          label={tx("Template text")}
          initialDoc={edit.doc}
          importFrom={null}
          features={{ quotes: false }}
          onChange={(next) => {
            setDoc(next);
            setProblem(null);
          }}
          onFiles={() => setProblem("A template cannot hold files.")}
          onReady={setEditor}
          onLinkShortcut={() => setLinkOpen(true)}
        />
      </div>
      {problem !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {tx("Cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {tx("Save template")}
        </Button>
      </div>
    </form>
  );
}
