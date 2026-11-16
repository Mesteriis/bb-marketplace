// The composer's formatting toolbar: bold, italic, underline, lists, link,
// quote and clear formatting. One tab stop with arrow-key (roving) focus,
// like a native toolbar; each button names its shortcut.
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** "⌘" on Apple platforms, "Ctrl+" elsewhere. */
export function modKeyLabel(platform: string = typeof navigator === "undefined" ? "" : navigator.platform): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl+";
}

export type ToolId = "bold" | "italic" | "underline" | "bulletList" | "orderedList" | "link" | "blockquote" | "clear";

interface Tool {
  id: ToolId;
  label: string;
  icon: string;
  fallback: string;
  /** The key after Cmd/Ctrl, when there is one. */
  key?: string;
}

const ALL_TOOLS: Tool[] = [
  { id: "bold", label: "Bold", icon: "Bold", fallback: "Type", key: "B" },
  { id: "italic", label: "Italic", icon: "Italic", fallback: "Type", key: "I" },
  { id: "underline", label: "Underline", icon: "Underline", fallback: "Type", key: "U" },
  { id: "bulletList", label: "Bulleted list", icon: "List", fallback: "ListChecks" },
  { id: "orderedList", label: "Numbered list", icon: "ListOrdered", fallback: "List" },
  { id: "link", label: "Link", icon: "Link", fallback: "ExternalLink", key: "K" },
  { id: "blockquote", label: "Quote", icon: "Quote", fallback: "MessageSquare" },
  { id: "clear", label: "Clear formatting", icon: "RemoveFormatting", fallback: "X" },
];

/**
 * A typed link address as an href the schema keeps: http, https and mailto
 * only; a bare host gets https://, a bare address mailto:. Null otherwise.
 */
export function linkHref(typed: string): string | null {
  const text = typed.trim();
  if (text === "" || /[\s<>"]/.test(text)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text)
    ? text
    : /^[^@/]+@[^@/]+\.[^@/]+$/.test(text)
      ? `mailto:${text}`
      : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    if (url.protocol !== "mailto:" && url.hostname === "") return null;
    return candidate;
  } catch {
    return null;
  }
}

export interface ComposeToolbarProps {
  editor: Editor | null;
  /** The link field is open (the toolbar's Link button or Cmd/Ctrl+K). */
  linkOpen: boolean;
  onLinkOpenChange: (open: boolean) => void;
  /** The tools shown, in the toolbar's order; all of them by default. */
  tools?: readonly ToolId[];
  /** The Templates button (the composer only): opens or closes the picker. */
  onTemplates?: () => void;
  templatesOpen?: boolean;
  /** Improve (slice 3f, the composer only): opens or closes its menu. */
  onImprove?: () => void;
  improveOpen?: boolean;
  /** Why Improve is off (Makosh AI is missing), or null. */
  improveDisabledReason?: string | null;
  className?: string;
}

export function ComposeToolbar({
  editor,
  linkOpen,
  onLinkOpenChange,
  tools: shown,
  onTemplates,
  templatesOpen,
  onImprove,
  improveOpen,
  improveDisabledReason = null,
  className,
}: ComposeToolbarProps) {
  const mod = modKeyLabel();
  const TOOLS = shown === undefined ? ALL_TOOLS : ALL_TOOLS.filter((tool) => shown.includes(tool.id));
  const [focusIndex, setFocusIndex] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current === null
        ? null
        : {
            bold: current.isActive("bold"),
            italic: current.isActive("italic"),
            underline: current.isActive("underline"),
            bulletList: current.isActive("bulletList"),
            orderedList: current.isActive("orderedList"),
            link: current.isActive("link"),
            blockquote: current.isActive("blockquote"),
          },
  });

  const run = (id: ToolId) => {
    if (editor === null) return;
    const chain = editor.chain().focus();
    switch (id) {
      case "bold":
        return void chain.toggleBold().run();
      case "italic":
        return void chain.toggleItalic().run();
      case "underline":
        return void chain.toggleUnderline().run();
      case "bulletList":
        return void chain.toggleBulletList().run();
      case "orderedList":
        return void chain.toggleOrderedList().run();
      case "blockquote":
        return void chain.toggleBlockquote().run();
      case "clear":
        return void chain.unsetAllMarks().clearNodes().run();
      case "link":
        onLinkOpenChange(!linkOpen);
        return;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = TOOLS.length - 1;
    const next =
      event.key === "ArrowRight"
        ? focusIndex === last ? 0 : focusIndex + 1
        : event.key === "ArrowLeft"
          ? focusIndex === 0 ? last : focusIndex - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    buttons.current[next]?.focus();
  };

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-center gap-1">
        <div
          role="toolbar"
          aria-label="Formatting"
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
          className="flex flex-wrap items-center gap-0.5"
        >
          {TOOLS.map((tool, index) => {
            const pressed = tool.id === "clear" ? undefined : (active?.[tool.id] ?? false);
            const hint = tool.key !== undefined ? `${tool.label} (${mod}${tool.key})` : tool.label;
            return (
              <Button
                key={tool.id}
                ref={(element) => {
                  buttons.current[index] = element;
                }}
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                tabIndex={index === focusIndex ? 0 : -1}
                aria-label={hint}
                aria-keyshortcuts={tool.key !== undefined ? `Control+${tool.key} Meta+${tool.key}` : undefined}
                aria-pressed={pressed}
                disabled={editor === null}
                onFocus={() => setFocusIndex(index)}
                // Keeps the editor's selection while the mouse is down.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => run(tool.id)}
              >
                <Icon name={tool.icon} fallback={tool.fallback} aria-hidden />
              </Button>
            );
          })}
        </div>
        {onImprove !== undefined ? (
          // A disabled button shows no tooltip of its own: the wrapper carries the reason.
          <span title={improveDisabledReason ?? undefined} className="ml-auto inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              aria-expanded={improveOpen === true}
              aria-description={improveDisabledReason ?? undefined}
              disabled={editor === null || improveDisabledReason !== null}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onImprove}
            >
              <Icon name="Sparkles" fallback="Bot" aria-hidden />
              Improve
              <Icon name="ChevronDown" fallback="ArrowDown" aria-hidden />
            </Button>
          </span>
        ) : null}
        {onTemplates !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("h-7 px-2", onImprove === undefined && "ml-auto")}
            aria-label={`Templates (${mod}${mod === "⌘" ? "⌥" : "Alt+"}T)`}
            aria-keyshortcuts="Control+Alt+T Meta+Alt+T"
            aria-expanded={templatesOpen === true}
            disabled={editor === null}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onTemplates}
          >
            <Icon name="FileText" fallback="Mail" aria-hidden />
            Templates
          </Button>
        ) : null}
      </div>
      {linkOpen && editor !== null ? (
        <LinkField editor={editor} onClose={() => onLinkOpenChange(false)} />
      ) : null}
    </div>
  );
}

function LinkField({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const current = (editor.getAttributes("link").href as string | undefined) ?? "";
  const [text, setText] = useState(current);
  const [problem, setProblem] = useState<string | null>(null);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      onClose();
      return;
    }
    const href = linkHref(text);
    if (href === null) {
      setProblem("Use a web address (https://…) or an email address.");
      return;
    }
    const chain = editor.chain().focus().extendMarkRange("link");
    if (editor.state.selection.empty && !editor.isActive("link")) {
      chain.insertContent({ type: "text", text: text.trim(), marks: [{ type: "link", attrs: { href } }] }).run();
    } else {
      chain.setLink({ href }).run();
    }
    onClose();
  };

  return (
    <form onSubmit={apply} className="flex flex-wrap items-center gap-1 pt-1" aria-label="Link">
      <Input
        autoFocus
        aria-label="Link address"
        aria-invalid={problem !== null}
        aria-describedby={problem !== null ? "compose-link-problem" : undefined}
        placeholder="https://example.org"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setProblem(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            editor.commands.focus();
          }
        }}
        className="h-7 min-w-40 flex-1 text-xs"
      />
      <Button type="submit" variant="outline" size="sm" className="h-7">
        Apply
      </Button>
      {current !== "" ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={() => {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            onClose();
          }}
        >
          Remove link
        </Button>
      ) : null}
      {problem !== null ? (
        <p id="compose-link-problem" role="alert" className="w-full text-xs text-destructive">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
