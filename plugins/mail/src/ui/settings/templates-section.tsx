import { useId, useState, type FormEvent } from "react";
import type { Editor } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { ComposeEditor, type EditorDoc } from "../compose-editor.tsx";
import { ComposeToolbar } from "../compose-toolbar.tsx";
import { editorDocEmpty } from "../signature-editor.tsx";
import { tx, txn } from "../i18n/index.ts";
import { type TemplateView, type TemplateFilesPort, TEMPLATE_TOOLS, type MailSettingsProps, messageOf, docPreview } from "./shared.ts";
import { formatBytes } from "../attachments-input.tsx";
import { SectionHeading } from "./primitives.tsx";

type TemplateEdit = { id: string | null; name: string; doc: EditorDoc; subject: string; to: string; cc: string; bcc: string };

const editOf = (template: TemplateView): TemplateEdit => ({
  id: template.id,
  name: template.name,
  doc: template.doc,
  subject: template.subject ?? "",
  to: (template.to ?? []).join(", "),
  cc: (template.cc ?? []).join(", "),
  bcc: (template.bcc ?? []).join(", "),
});

/** Addresses typed in one field, separated by commas, semicolons or new lines. */
const addressesOf = (text: string) =>
  text
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");

/** What a template fills beside the body, as one line for the list; null when nothing. */
export function carriesText(template: TemplateView): string | null {
  const parts: string[] = [];
  if ((template.subject ?? "") !== "") parts.push(tx("Subject: {p1}", { p1: template.subject ?? "" }));
  const people = (template.to?.length ?? 0) + (template.cc?.length ?? 0) + (template.bcc?.length ?? 0);
  if (people > 0) parts.push(txn(people, "{count} recipient", "{count} recipients", { count: people }));
  const files = template.files?.length ?? 0;
  if (files > 0) parts.push(txn(files, "{count} file", "{count} files", { count: files }));
  return parts.length === 0 ? null : parts.join(" \u00b7 ");
}

export function TemplatesSection({
  templates,
  onSave,
  onDelete,
  files,
}: {
  templates: readonly TemplateView[];
  onSave: MailSettingsProps["onSaveTemplate"];
  onDelete: MailSettingsProps["onDeleteTemplate"];
  /** Typing speed: a saved template's files; absent: none in the form. */
  files?: TemplateFilesPort;
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
                setEditing({ id: null, name: "", doc: { type: "doc", content: [{ type: "paragraph" }] }, subject: "", to: "", cc: "", bcc: "" });
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
          kept={templates.find((template) => template.id === editing.id)?.files ?? []}
          {...(files !== undefined ? { files } : {})}
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
                    setEditing(editOf(template));
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
              {carriesText(template) !== null ? <p className="truncate text-xs text-muted-foreground">{carriesText(template)}</p> : null}
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
  kept,
  files,
  onSave,
  onCancel,
}: {
  edit: TemplateEdit;
  /** The saved template's files. */
  kept: readonly { id: string; name: string; size: number }[];
  files?: TemplateFilesPort;
  onSave: MailSettingsProps["onSaveTemplate"];
  onCancel: () => void;
}) {
  const id = useId();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [name, setName] = useState(edit.name);
  const [subject, setSubject] = useState(edit.subject);
  const [to, setTo] = useState(edit.to);
  const [cc, setCc] = useState(edit.cc);
  const [bcc, setBcc] = useState(edit.bcc);
  const [fileBusy, setFileBusy] = useState(false);
  const fileChange = (work: Promise<void>) => {
    setFileBusy(true);
    setProblem(null);
    work.catch((error: unknown) => setProblem(messageOf(error, "Could not change the template's files."))).finally(() => setFileBusy(false));
  };
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
      await onSave({
        ...(edit.id !== null ? { id: edit.id } : {}),
        name: name.trim(),
        doc,
        subject: subject.trim(),
        to: addressesOf(to),
        cc: addressesOf(cc),
        bcc: addressesOf(bcc),
      });
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
      <p className="text-xs text-muted-foreground">
        {tx("{first_name} in the text or the subject becomes the first recipient's first name. Everything below is optional.")}
      </p>
      <div className="grid gap-2 @xl:grid-cols-2">
        {(
          [
            [tx("Subject"), subject, setSubject, "subject", 200],
            [tx("To"), to, setTo, "to", 2000],
            [tx("Cc"), cc, setCc, "cc", 2000],
            [tx("Bcc"), bcc, setBcc, "bcc", 2000],
          ] as const
        ).map(([label, value, set, key, max]) => (
          <div key={key} className="flex flex-col gap-1">
            <label htmlFor={`${id}-${key}`} className="text-xs text-muted-foreground">
              {label}
            </label>
            <Input
              id={`${id}-${key}`}
              value={value}
              maxLength={max}
              placeholder={key === "subject" ? "" : "ada@example.com, bob@example.com"}
              onChange={(event) => {
                set(event.target.value.replace(/[\r\n]+/g, " "));
                setProblem(null);
              }}
              className="h-8"
            />
          </div>
        ))}
      </div>
      {files !== undefined ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">{tx("Files (up to 5, 10 MB together)")}</p>
          {edit.id === null ? (
            <p className="text-xs text-muted-foreground">{tx("Save the template first, then add its files.")}</p>
          ) : (
            <>
              {kept.length > 0 ? (
                <ul aria-label={tx("Template files")} className="flex flex-col divide-y divide-border rounded-md border border-border">
                  {kept.map((file) => (
                    <li key={file.id} className="flex items-center gap-2 px-2 py-1">
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{file.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.size)}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7"
                        disabled={fileBusy}
                        aria-label={tx("Remove {p1}", { p1: file.name })}
                        onClick={() => fileChange(files.remove(edit.id as string, file.id))}
                      >
                        {tx("Remove")}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <input
                type="file"
                multiple
                aria-label={tx("Add files to the template")}
                disabled={fileBusy || kept.length >= 5}
                className="text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-border file:bg-transparent file:px-2 file:py-1 file:text-xs file:text-foreground"
                onChange={(event) => {
                  const picked = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  if (picked.length === 0) return;
                  fileChange(picked.reduce((chain, file) => chain.then(() => files.add(edit.id as string, file)), Promise.resolve()));
                }}
              />
            </>
          )}
        </div>
      ) : null}
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
