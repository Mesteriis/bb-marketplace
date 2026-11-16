// The `?` sheet: every Mail hotkey; an entry reserved for later is marked "soon".
// On a Mac each row also shows its Apple Mail chord (slice 3i).
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isMacPlatform, SHORTCUT_SHEET, stopEscape } from "./shortcuts.ts";

const KBD = "rounded-sm border border-border bg-muted px-1.5 font-mono text-xs text-foreground";

export function ShortcutSheet({
  open,
  onOpenChange,
  onCloseAutoFocus,
  onAfterCloseAutoFocus,
  mac = isMacPlatform(),
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes when the sheet closes (it has no trigger to return to). */
  onCloseAutoFocus?: (event: Event) => void;
  /** The compact (drawer) layout's close hook. */
  onAfterCloseAutoFocus?: () => void;
  /** Show the Apple Mail chords (the page runs on a Mac). */
  mac?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto" onEscapeKeyDown={stopEscape}
        onCloseAutoFocus={onCloseAutoFocus}
        onAfterCloseAutoFocus={onAfterCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            They work while the Mail page has focus and you are not typing.
          </DialogDescription>
          <p className="text-sm text-muted-foreground">On a Mac, Apple Mail keys work too.</p>
        </DialogHeader>
        {SHORTCUT_SHEET.map((section) => (
          <section key={section.title} aria-label={section.title} className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">{section.title}</h3>
            <dl className="flex flex-col gap-1">
              {section.entries.filter((entry) => entry.keys.length > 0 || (mac && entry.mac !== undefined)).map((entry) => (
                <div key={entry.label} className="flex items-center justify-between gap-3 text-sm">
                  <dt className="text-foreground">
                    {entry.label}
                    {entry.soon ? <span className="ml-2 text-xs text-muted-foreground">soon</span> : null}
                  </dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {entry.keys.map((name, index) => (
                      <kbd key={index} className={KBD}>
                        {name}
                      </kbd>
                    ))}
                    {mac && entry.mac !== undefined ? (
                      <>
                        {entry.keys.length > 0 ? <span className="text-xs text-muted-foreground">or</span> : null}
                        <kbd className={KBD}>{entry.mac.join("")}</kbd>
                      </>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}
