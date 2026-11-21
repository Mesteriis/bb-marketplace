// The switcher of named layouts: the list with the active one, create from
// the current layout or a preset, rename, duplicate, delete after a
// confirmation, and the state of the last save. It owns only the text being
// typed; every change goes out through a callback.
import { type FormEvent, type KeyboardEvent, useId, useRef, useState } from "react";
import { Icon, classes, moveByArrows, usePendingFocus, usePopover } from "./primitives.tsx";
import { chromeStrings } from "./strings.ts";
import type { LayoutEntry, LayoutPresetEntry, SaveStatus } from "./types.ts";

const text = chromeStrings.layouts;

/** The longest name the workspace document stores. */
const DEFAULT_MAX_NAME_LENGTH = 64;

export interface LayoutSwitcherProps {
  layouts: readonly LayoutEntry[];
  activeLayoutId: string;
  presets: readonly LayoutPresetEntry[];
  saveStatus: SaveStatus;
  maxNameLength?: number;
  onSwitch: (layoutId: string) => void;
  /** The name is trimmed, not empty, within the length limit and not used by another layout. */
  onCreateFromCurrent: (name: string) => void;
  onCreateFromPreset: (presetId: string, name: string) => void;
  onRename: (layoutId: string, name: string) => void;
  onDuplicate: (layoutId: string, name: string) => void;
  /** Called only after the user confirmed. */
  onDelete: (layoutId: string) => void;
  /** Take the other window's version after a conflict. */
  onReload: () => void;
}

const sameName = (left: string, right: string) => left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

type NameCheck = { name: string; error: null } | { name: null; error: string };

function checkName(raw: string, layouts: readonly LayoutEntry[], limit: number, exceptId?: string): NameCheck {
  const name = raw.trim();
  if (name === "") return { name: null, error: text.errorEmpty };
  if (name.length > limit) return { name: null, error: text.errorTooLong(limit) };
  if (layouts.some((layout) => layout.id !== exceptId && sameName(layout.name, name))) {
    return { name: null, error: text.errorDuplicate };
  }
  return { name, error: null };
}

/** The first candidate no layout uses. The base is shortened so that the suffix fits the limit. */
function freeName(layouts: readonly LayoutEntry[], limit: number, candidate: (number: number) => { base: string; suffix: string }): string {
  for (let number = 1; ; number += 1) {
    const { base, suffix } = candidate(number);
    const name = base.slice(0, Math.max(limit - suffix.length, 1)).trimEnd() + suffix;
    if (!layouts.some((layout) => sameName(layout.name, name))) return name;
  }
}

function copyName(source: string, layouts: readonly LayoutEntry[], limit: number): string {
  return freeName(layouts, limit, (number) => ({ base: source, suffix: text.copyName("", number) }));
}

function presetName(preset: string, layouts: readonly LayoutEntry[], limit: number): string {
  return freeName(layouts, limit, (number) => ({ base: preset, suffix: number === 1 ? "" : text.numberedName("", number) }));
}

/**
 * The row being renamed or asked about. It names the layout by id, never by
 * its place in the list: another window can add or remove rows meanwhile.
 */
type RowMode = { kind: "rename"; layoutId: string; value: string; error: string | null } | { kind: "delete"; layoutId: string } | null;

const rowControl = (layoutId: string, selector: string) => (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-row-id]"))
    .find((row) => row.dataset.rowId === layoutId)
    ?.querySelector<HTMLElement>(selector);

const rowAction = (layoutId: string, action: string) => rowControl(layoutId, `[data-action="${action}"]`);

export function LayoutSwitcher(props: LayoutSwitcherProps) {
  const { layouts, activeLayoutId, presets, saveStatus } = props;
  const limit = props.maxNameLength ?? DEFAULT_MAX_NAME_LENGTH;
  const popover = usePopover();
  const requestFocus = usePendingFocus(popover.rootRef);
  const listRef = useRef<HTMLUListElement>(null);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [storedRowMode, setRowMode] = useState<RowMode>(null);
  // A row whose layout is gone has nothing left to rename or delete.
  const rowMode = storedRowMode !== null && layouts.some((layout) => layout.id === storedRowMode.layoutId) ? storedRowMode : null;
  const ids = { create: useId(), createError: useId(), rowError: useId(), rowNote: useId() };

  const active = layouts.find((layout) => layout.id === activeLayoutId);

  function reset() {
    setNewName("");
    setCreateError(null);
    setRowMode(null);
  }

  function toggle() {
    if (popover.open) {
      reset();
      popover.close();
      return;
    }
    reset();
    popover.setOpen(true);
    requestFocus(
      (container) =>
        container.querySelector<HTMLElement>('[data-action="switch"][aria-current="true"]') ??
        container.querySelector<HTMLElement>('[data-action="switch"]'),
    );
  }

  function closeAfter(action: () => void) {
    action();
    reset();
    popover.close();
  }

  function submitCreate(event: FormEvent) {
    event.preventDefault();
    const checked = checkName(newName, layouts, limit);
    if (checked.name === null) return setCreateError(checked.error);
    const name = checked.name;
    closeAfter(() => props.onCreateFromCurrent(name));
  }

  function submitRename(event: FormEvent, layout: LayoutEntry) {
    event.preventDefault();
    if (rowMode?.kind !== "rename") return;
    const checked = checkName(rowMode.value, layouts, limit, layout.id);
    if (checked.name === null) return setRowMode({ ...rowMode, error: checked.error });
    if (checked.name !== layout.name) props.onRename(layout.id, checked.name);
    leaveRow(layout.id, "switch");
  }

  function leaveRow(layoutId: string, focusAction: string) {
    setRowMode(null);
    requestFocus(rowAction(layoutId, focusAction));
  }

  function onPopoverKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && rowMode !== null) {
      // Escape leaves the rename or the delete question first, and the list on the next press.
      event.stopPropagation();
      leaveRow(rowMode.layoutId, rowMode.kind === "rename" ? "rename" : "delete");
      return;
    }
    if (event.key === "Escape") reset();
    popover.onKeyDown(event);
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div ref={popover.rootRef} className="relative min-w-0" onKeyDown={onPopoverKeyDown} onBlur={popover.onBlur}>
        <button
          ref={popover.triggerRef}
          type="button"
          data-toolbar-item
          className={`${classes.button} max-w-56`}
          aria-haspopup="dialog"
          aria-expanded={popover.open}
          aria-label={active === undefined ? text.triggerNone : text.trigger(active.name)}
          onClick={toggle}
        >
          <span className="truncate">{active === undefined ? text.triggerNone : active.name}</span>
          <Icon name="chevron" />
        </button>

        {popover.open && (
          <div role="dialog" aria-label={text.popoverLabel} className={`${classes.popover} left-0`}>
            <ul
              ref={listRef}
              aria-label={text.listLabel}
              className="flex flex-col gap-0.5"
              onKeyDown={(event) => {
                if (rowMode === null) moveByArrows(event, listRef.current);
              }}
            >
              {layouts.map((layout) => (
                <li key={layout.id} data-row-id={layout.id} className="flex min-h-7 flex-col gap-1">
                  {rowMode?.kind === "rename" && rowMode.layoutId === layout.id ? (
                    <form className="flex flex-col gap-1" noValidate onSubmit={(event) => submitRename(event, layout)}>
                      <div className="flex items-center gap-1">
                        <input
                          className={classes.input}
                          aria-label={text.renameField(layout.name)}
                          aria-invalid={rowMode.error !== null}
                          aria-describedby={rowMode.error !== null ? ids.rowError : undefined}
                          maxLength={limit}
                          value={rowMode.value}
                          onChange={(event) => setRowMode({ ...rowMode, value: event.target.value, error: null })}
                        />
                        <button type="submit" className={classes.primaryButton}>
                          {text.renameSave}
                        </button>
                        <button type="button" className={classes.button} onClick={() => leaveRow(layout.id, "rename")}>
                          {text.renameCancel}
                        </button>
                      </div>
                      {rowMode.error !== null && (
                        <p id={ids.rowError} role="alert" className={classes.error}>
                          {rowMode.error}
                        </p>
                      )}
                    </form>
                  ) : rowMode?.kind === "delete" && rowMode.layoutId === layout.id ? (
                    <div role="group" aria-labelledby={ids.rowNote} className="flex flex-col gap-1 rounded-md bg-secondary p-1.5">
                      <p id={ids.rowNote} className="text-xs">
                        {text.removeQuestion(layout.name)}
                      </p>
                      <div className="flex justify-end gap-1">
                        <button type="button" data-action="cancel-delete" className={classes.button} onClick={() => leaveRow(layout.id, "delete")}>
                          {text.removeCancel}
                        </button>
                        <button
                          type="button"
                          className={classes.dangerButton}
                          onClick={() => {
                            props.onDelete(layout.id);
                            setRowMode(null);
                            requestFocus((container) => container.querySelector<HTMLElement>('[data-action="switch"]'));
                          }}
                        >
                          {text.removeConfirm}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        data-nav
                        data-action="switch"
                        aria-current={layout.id === activeLayoutId ? "true" : undefined}
                        className={`flex h-7 min-w-0 flex-1 items-center rounded-md px-2 text-left text-xs hover:bg-state-hover aria-[current=true]:bg-state-active aria-[current=true]:font-medium ${classes.focusRing}`}
                        onClick={() => closeAfter(() => layout.id !== activeLayoutId && props.onSwitch(layout.id))}
                      >
                        <span className="truncate">{layout.name}</span>
                      </button>
                      <button
                        type="button"
                        data-action="rename"
                        className={classes.iconButton}
                        aria-label={text.rename(layout.name)}
                        title={text.rename(layout.name)}
                        onClick={() => {
                          setRowMode({ kind: "rename", layoutId: layout.id, value: layout.name, error: null });
                          requestFocus(rowControl(layout.id, "input"));
                        }}
                      >
                        <Icon name="pencil" />
                      </button>
                      <button
                        type="button"
                        className={classes.iconButton}
                        aria-label={text.duplicate(layout.name)}
                        title={text.duplicate(layout.name)}
                        onClick={() => props.onDuplicate(layout.id, copyName(layout.name, layouts, limit))}
                      >
                        <Icon name="copy" />
                      </button>
                      <button
                        type="button"
                        data-action="delete"
                        className={classes.iconButton}
                        aria-label={text.remove(layout.name)}
                        title={layouts.length === 1 ? text.removeLastHint : text.remove(layout.name)}
                        disabled={layouts.length === 1}
                        onClick={() => {
                          setRowMode({ kind: "delete", layoutId: layout.id });
                          requestFocus(rowAction(layout.id, "cancel-delete"));
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>

            <form className="flex flex-col gap-1 border-t border-border pt-2" noValidate onSubmit={submitCreate}>
              <label htmlFor={ids.create} className={classes.sectionHeading}>
                {text.createHeading}
              </label>
              <div className="flex items-center gap-1">
                <input
                  id={ids.create}
                  className={classes.input}
                  aria-label={text.createField}
                  aria-invalid={createError !== null}
                  aria-describedby={createError !== null ? ids.createError : undefined}
                  placeholder={text.createPlaceholder}
                  maxLength={limit}
                  value={newName}
                  onChange={(event) => {
                    setNewName(event.target.value);
                    setCreateError(null);
                  }}
                />
                <button type="submit" className={classes.primaryButton}>
                  {text.createSubmit}
                </button>
              </div>
              {createError !== null && (
                <p id={ids.createError} role="alert" className={classes.error}>
                  {createError}
                </p>
              )}
            </form>

            {presets.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-border pt-2">
                <p className={classes.sectionHeading}>{text.presetsHeading}</p>
                <ul className="flex flex-col gap-0.5">
                  {presets.map((preset) => (
                    <li key={preset.id}>
                      <button
                        type="button"
                        className={`flex min-h-7 w-full flex-col items-start rounded-md px-2 py-1 text-left text-xs hover:bg-state-hover ${classes.focusRing}`}
                        aria-label={text.presetCreate(preset.name)}
                        onClick={() => {
                          const name = presetName(preset.name, layouts, limit);
                          closeAfter(() => props.onCreateFromPreset(preset.id, name));
                        }}
                      >
                        <span className="flex items-center gap-1">
                          <Icon name="plus" />
                          {preset.name}
                        </span>
                        {preset.description !== undefined && <span className="text-muted-foreground">{preset.description}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <span role="status" className={`truncate text-xs ${saveStatus === "conflict" ? "text-destructive" : "text-muted-foreground"}`}>
        {chromeStrings.saveStatus[saveStatus]}
      </span>
      {saveStatus === "conflict" && (
        <button type="button" data-toolbar-item className={classes.button} onClick={props.onReload}>
          {chromeStrings.saveStatus.reload}
        </button>
      )}
    </div>
  );
}
