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
  saveDetail?: string | undefined;
  onRetrySave: () => void;
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

/**
 * The first numbered candidate that passes the same check as a typed name,
 * or `null` when none does. The base is cut so that the whole name fits the
 * limit; a suffix that leaves no room for the base ends the search, because
 * the suffixes only get longer.
 */
function freeName(base: string, layouts: readonly LayoutEntry[], limit: number, suffixOf: (number: number) => string): string | null {
  // One more candidate than there are layouts: they cannot all be taken.
  for (let number = 1; number <= layouts.length + 1; number += 1) {
    const suffix = suffixOf(number);
    const room = limit - suffix.length;
    if (room < 1) return null;
    const stem = base.trim().slice(0, room).trimEnd();
    if (stem === "") return null;
    const checked = checkName(stem + suffix, layouts, limit);
    if (checked.name !== null) return checked.name;
  }
  return null;
}

function copyName(source: string, layouts: readonly LayoutEntry[], limit: number): string | null {
  return freeName(source, layouts, limit, (number) => text.copyName("", number));
}

function presetName(preset: string, layouts: readonly LayoutEntry[], limit: number): string | null {
  return freeName(preset, layouts, limit, (number) => (number === 1 ? "" : text.numberedName("", number)));
}

/**
 * The row being renamed, given a copy name, or asked about. It names the
 * layout by id, never by its place in the list: another window can add or
 * remove rows meanwhile. `duplicate` is the name form shown when no copy name
 * could be generated within the limit.
 */
type RowMode =
  | { kind: "rename" | "duplicate"; layoutId: string; value: string; error: string | null }
  | { kind: "delete"; layoutId: string }
  | null;

/** The name form of a preset whose name could not be generated within the limit. */
type PresetMode = { presetId: string; value: string; error: string | null } | null;

const rowControl = (layoutId: string, selector: string) => (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-row-id]"))
    .find((row) => row.dataset.rowId === layoutId)
    ?.querySelector<HTMLElement>(selector);

const rowAction = (layoutId: string, action: string) => rowControl(layoutId, `[data-action="${action}"]`);

const presetControl = (presetId: string, selector: string) => (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-preset-id]"))
    .find((row) => row.dataset.presetId === presetId)
    ?.querySelector<HTMLElement>(selector);

interface NameFormProps {
  label: string;
  value: string;
  error: string | null;
  errorId: string;
  limit: number;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** One line to type a layout name in, with the reason it was refused under it. */
function NameForm({ label, value, error, errorId, limit, onChange, onSubmit, onCancel }: NameFormProps) {
  return (
    <form
      className="flex flex-col gap-1"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex items-center gap-1">
        <input
          className={classes.input}
          aria-label={label}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          maxLength={limit}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="submit" className={classes.primaryButton}>
          {text.renameSave}
        </button>
        <button type="button" className={classes.button} onClick={onCancel}>
          {text.renameCancel}
        </button>
      </div>
      {error !== null && (
        <p id={errorId} role="alert" className={classes.error}>
          {error}
        </p>
      )}
    </form>
  );
}

export function LayoutSwitcher(props: LayoutSwitcherProps) {
  const { layouts, activeLayoutId, presets, saveStatus } = props;
  const limit = props.maxNameLength ?? DEFAULT_MAX_NAME_LENGTH;
  const popover = usePopover("start");
  const requestFocus = usePendingFocus(popover.rootRef);
  const listRef = useRef<HTMLUListElement>(null);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [storedRowMode, setRowMode] = useState<RowMode>(null);
  // A row whose layout is gone has nothing left to rename or delete.
  const rowMode = storedRowMode !== null && layouts.some((layout) => layout.id === storedRowMode.layoutId) ? storedRowMode : null;
  const [storedPresetMode, setPresetMode] = useState<PresetMode>(null);
  const presetMode = storedPresetMode !== null && presets.some((preset) => preset.id === storedPresetMode.presetId) ? storedPresetMode : null;
  const ids = { create: useId(), createError: useId(), rowError: useId(), rowNote: useId(), presetError: useId() };

  const active = layouts.find((layout) => layout.id === activeLayoutId);

  function reset() {
    setNewName("");
    setCreateError(null);
    setRowMode(null);
    setPresetMode(null);
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

  function submitRowName(layout: LayoutEntry) {
    if (rowMode === null || rowMode.kind === "delete") return;
    const renaming = rowMode.kind === "rename";
    const checked = checkName(rowMode.value, layouts, limit, renaming ? layout.id : undefined);
    if (checked.name === null) return setRowMode({ ...rowMode, error: checked.error });
    if (!renaming) props.onDuplicate(layout.id, checked.name);
    else if (checked.name !== layout.name) props.onRename(layout.id, checked.name);
    leaveRow(layout.id, renaming ? "switch" : "duplicate");
  }

  function duplicate(layout: LayoutEntry) {
    const name = copyName(layout.name, layouts, limit);
    if (name !== null) return props.onDuplicate(layout.id, name);
    setPresetMode(null);
    setRowMode({ kind: "duplicate", layoutId: layout.id, value: layout.name.trim().slice(0, limit), error: text.errorNoFreeName });
    requestFocus(rowControl(layout.id, "input"));
  }

  function createFromPreset(preset: LayoutPresetEntry) {
    const name = presetName(preset.name, layouts, limit);
    if (name !== null) return closeAfter(() => props.onCreateFromPreset(preset.id, name));
    setRowMode(null);
    setPresetMode({ presetId: preset.id, value: preset.name.trim().slice(0, limit).trimEnd(), error: text.errorNoFreeName });
    requestFocus(presetControl(preset.id, "input"));
  }

  function submitPresetName(preset: LayoutPresetEntry) {
    if (presetMode === null) return;
    const checked = checkName(presetMode.value, layouts, limit);
    if (checked.name === null) return setPresetMode({ ...presetMode, error: checked.error });
    const name = checked.name;
    closeAfter(() => props.onCreateFromPreset(preset.id, name));
  }

  function leavePreset(presetId: string) {
    setPresetMode(null);
    requestFocus(presetControl(presetId, "button"));
  }

  function leaveRow(layoutId: string, focusAction: string) {
    setRowMode(null);
    requestFocus(rowAction(layoutId, focusAction));
  }

  function onPopoverKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && rowMode !== null) {
      // Escape leaves the name form or the delete question first, and the list on the next press.
      event.stopPropagation();
      leaveRow(rowMode.layoutId, rowMode.kind);
      return;
    }
    if (event.key === "Escape" && presetMode !== null) {
      event.stopPropagation();
      leavePreset(presetMode.presetId);
      return;
    }
    if (event.key === "Escape") reset();
    popover.onKeyDown(event);
  }

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1">
      <div ref={popover.rootRef} className="relative min-w-0 max-w-56" onKeyDown={onPopoverKeyDown} onBlur={popover.onBlur}>
        <button
          ref={popover.triggerRef}
          type="button"
          data-focus-return
          data-toolbar-item
          title={active?.name}
          className={`${classes.button} w-max max-w-full`}
          aria-haspopup="dialog"
          aria-expanded={popover.open}
          aria-label={active === undefined ? text.triggerNone : text.trigger(active.name)}
          onClick={toggle}
        >
          <span className="truncate">{active === undefined ? text.triggerNone : active.name}</span>
          <Icon name="chevron" />
        </button>

        {popover.open && (
          <div ref={popover.panelRef} role="dialog" tabIndex={-1} aria-label={text.popoverLabel} className={classes.popover}>
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
                  {rowMode !== null && rowMode.kind !== "delete" && rowMode.layoutId === layout.id ? (
                    <NameForm
                      label={rowMode.kind === "rename" ? text.renameField(layout.name) : text.duplicateField(layout.name)}
                      value={rowMode.value}
                      error={rowMode.error}
                      errorId={ids.rowError}
                      limit={limit}
                      onChange={(value) => setRowMode({ ...rowMode, value, error: null })}
                      onSubmit={() => submitRowName(layout)}
                      onCancel={() => leaveRow(layout.id, rowMode.kind)}
                    />
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
                        title={layout.name}
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
                          setPresetMode(null);
                          setRowMode({ kind: "rename", layoutId: layout.id, value: layout.name, error: null });
                          requestFocus(rowControl(layout.id, "input"));
                        }}
                      >
                        <Icon name="pencil" />
                      </button>
                      <button
                        type="button"
                        data-action="duplicate"
                        className={classes.iconButton}
                        aria-label={text.duplicate(layout.name)}
                        title={text.duplicate(layout.name)}
                        onClick={() => duplicate(layout)}
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
                          setPresetMode(null);
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
                    <li key={preset.id} data-preset-id={preset.id}>
                      {presetMode?.presetId === preset.id ? (
                        <NameForm
                          label={text.presetField(preset.name)}
                          value={presetMode.value}
                          error={presetMode.error}
                          errorId={ids.presetError}
                          limit={limit}
                          onChange={(value) => setPresetMode({ ...presetMode, value, error: null })}
                          onSubmit={() => submitPresetName(preset)}
                          onCancel={() => leavePreset(preset.id)}
                        />
                      ) : (
                        <button
                          type="button"
                          className={`flex min-h-7 w-full flex-col items-start rounded-md px-2 py-1 text-left text-xs hover:bg-state-hover ${classes.focusRing}`}
                          aria-label={text.presetCreate(preset.name)}
                          onClick={() => createFromPreset(preset)}
                        >
                          <span className="flex items-center gap-1">
                            <Icon name="plus" />
                            {preset.name}
                          </span>
                          {preset.description !== undefined && <span className="text-muted-foreground">{preset.description}</span>}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <span
        role="status"
        title={props.saveDetail ?? chromeStrings.saveStatus[saveStatus]}
        aria-description={props.saveDetail}
        className={`max-w-full truncate text-xs ${saveStatus === "conflict" || saveStatus === "failed" ? "text-destructive" : "text-muted-foreground"}`}
      >
        {chromeStrings.saveStatus[saveStatus]}
      </span>
      {(saveStatus === "failed" || saveStatus === "conflict") && (
        <button type="button" data-toolbar-item className={classes.button} onClick={props.onRetrySave}>
          {chromeStrings.saveStatus.retry}
        </button>
      )}
      {saveStatus === "conflict" && (
        <button type="button" data-toolbar-item className={classes.button} onClick={props.onReload}>
          {chromeStrings.saveStatus.reload}
        </button>
      )}
    </div>
  );
}
