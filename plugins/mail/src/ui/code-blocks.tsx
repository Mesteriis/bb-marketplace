// Code in a mail body (slice 3g, #51): a plain body split into text runs and
// code, diff and log blocks (core codeBlocks), each block drawn by BB's
// highlighter or diff viewer when app.tsx injects them, else a monospace
// <pre>. Every block has Copy. An HTML body's <pre> texts show under the
// frame as "Code (N)". The mail's text is never parsed as HTML here.
import { useState, type ReactNode } from "react";
import { codeBlocks, type BodyPart } from "../core/code-blocks.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { CodeRenderers } from "./bb-ports.ts";
import { tx } from "./i18n/index.ts";

const TEXT_CLASS = "whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground";
const PRE_CLASS = "max-h-96 overflow-auto whitespace-pre rounded-md border border-border bg-muted p-2 font-mono text-xs text-foreground";

/** Copies text to the clipboard; false when the page may not. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ text, onCopy }: { text: string; onCopy?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-xs"
      onClick={() => {
        if (onCopy !== undefined) {
          onCopy(text);
          setCopied(true);
          return;
        }
        void copyText(text).then(setCopied);
      }}
    >
      <Icon name="Copy" fallback="Check" className="size-3" aria-hidden />
      {copied ? tx("Copied") : tx("Copy")}
    </Button>
  );
}

function Block({ label, copy, children, onCopy }: { label: string; copy: string; children: ReactNode; onCopy?: (text: string) => void }) {
  return (
    <figure aria-label={label} className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2">
        <figcaption className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{label}</figcaption>
        <CopyButton text={copy} onCopy={onCopy} />
      </div>
      {children}
    </figure>
  );
}

/** One code text through the injected highlighter, or the <pre> fallback. */
export function CodeView({ content, path, renderers }: { content: string; path: string; renderers: CodeRenderers }) {
  if (renderers.renderCode !== undefined) return <div className="min-w-0 overflow-hidden rounded-md border border-border">{renderers.renderCode(content, path)}</div>;
  return <pre className={PRE_CLASS}>{content}</pre>;
}

/** One file's patch through the injected diff viewer, or the <pre> fallback. */
export function DiffView({ patch, path, renderers }: { patch: string; path: string; renderers: CodeRenderers }) {
  if (renderers.renderDiff !== undefined) return <div className="min-w-0 overflow-hidden rounded-md border border-border">{renderers.renderDiff(patch, path)}</div>;
  return <pre className={PRE_CLASS}>{patch}</pre>;
}

export function partLabel(part: Exclude<BodyPart, { kind: "text" }>): string {
  if (part.kind === "log") return "Log";
  if (part.kind === "diff") return part.files.length === 1 ? `Diff: ${part.files[0]!.path}` : `Diff: ${part.files.length} files`;
  return part.language !== null ? `Code (${part.language})` : "Code";
}

/** A plain body's parts: text as before, code blocks drawn as code. */
export function BodyParts({ text, renderers }: { text: string; renderers: CodeRenderers }) {
  const parts = codeBlocks(text);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {parts.map((part, index) => {
        if (part.kind === "text") {
          return (
            <pre key={index} className={TEXT_CLASS}>
              {part.text}
            </pre>
          );
        }
        if (part.kind === "diff") {
          return (
            <Block key={index} label={partLabel(part)} copy={part.files.map((f) => f.patch).join("\n")} onCopy={renderers.copy}>
              {part.files.map((file) => (
                <DiffView key={file.path} patch={file.patch} path={file.path} renderers={renderers} />
              ))}
            </Block>
          );
        }
        return (
          <Block key={index} label={partLabel(part)} copy={part.text} onCopy={renderers.copy}>
            <CodeView content={part.text} path={part.path} renderers={renderers} />
          </Block>
        );
      })}
    </div>
  );
}

/** "Code (N)" under an HTML message: its <pre> blocks, collapsed. */
export function HtmlCodeBlocks({ blocks, renderers }: { blocks: readonly string[]; renderers: CodeRenderers }) {
  if (blocks.length === 0) return null;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">{`Code (${blocks.length})`}</summary>
      <div className="mt-2 flex flex-col gap-2">
        {blocks.map((block, index) => (
          <Block key={index} label={`Block ${index + 1}`} copy={block} onCopy={renderers.copy}>
            <CodeView content={block} path="snippet.txt" renderers={renderers} />
          </Block>
        ))}
      </div>
    </details>
  );
}
