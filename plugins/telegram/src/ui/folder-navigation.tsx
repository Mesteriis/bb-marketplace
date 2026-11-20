import { useTelegramLocale } from "./i18n/index.tsx";
import { folderColors } from "./folder-colors.ts";
import { FolderGlyph } from "./folder-glyph.tsx";
import { ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ChatList, TelegramFolder } from "../core/contract.ts";
import { folderChoices, folderTree, type FolderNode } from "../core/folder-tree.ts";
import { isPlainKey } from "./composer-keys.ts";

export const chatFolderDragType = "application/x-makosh-telegram-chat";

export function RecipientFolderSelect({ folders, selected, select, defaultLabel, disabled }: {
  folders: readonly TelegramFolder[];
  selected?: number;
  select: (id?: number) => void;
  defaultLabel: string;
  disabled?: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  if (!folders.length) return null;
  const options = folderChoices(folders);
  return <label className="mtg-recipient-folder">{tr("Recipient folder ")}<select value={selected ?? ""} disabled={disabled}
    onChange={(event) => select(options.find(({ id }) => String(id) === event.currentTarget.value)?.id)}>
    <option value="">{defaultLabel}</option>
    {options.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
  </select></label>;
}

type FolderDrop = {
  target?: number;
  canDrop: (id: number) => boolean;
  highlight: (id?: number) => void;
  add: (id: number) => void;
};

export function UnreadListBadge({ count }: { count?: number }) {
  return count ? <span className="mtg-unread mtg-list-unread" aria-hidden="true">{count > 999 ? "999+" : count}</span> : null;
}

function containsFolder(node: FolderNode, selected: ChatList): boolean {
  return node.folders.some(({ id }) => id === selected)
    || node.children.some((child) => containsFolder(child, selected));
}

function foldersWithUnread(node: FolderNode, badges: ReadonlyMap<ChatList, number>): number {
  return node.folders.filter(({ id }) => (badges.get(id) ?? 0) > 0).length
    + node.children.reduce((count, child) => count + foldersWithUnread(child, badges), 0);
}

function FolderBranch({ node, selected, selectedPath, select, unreadBadges, drop }: {
  node: FolderNode;
  drop?: FolderDrop;
  selected: ChatList;
  selectedPath?: string;
  unreadBadges?: ReadonlyMap<ChatList, number>;
  select: (id: number) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const [open, setOpen] = useState(true);
  const childrenId = useId();
  const nested = node.children.length > 0;
  const selectedBranch = containsFolder(node, selected);
  const hidesSelection = !open && selectedBranch && !node.folders.some(({ id }) => id === selected);
  const unreadFolders = !open && unreadBadges ? node.children.reduce((count, child) =>
    count + foldersWithUnread(child, unreadBadges), 0) : 0;
  const branchDescription = [
    hidesSelection && "Contains the current folder",
    unreadFolders === 1 ? "1 subfolder has unread chats" : unreadFolders > 1 && `${unreadFolders} subfolders have unread chats`,
  ].filter(Boolean).join(". ");
  useEffect(() => {
    if (selectedBranch) setOpen(true);
  }, [selected, selectedBranch, selectedPath]);
  return <li>
    <div className="mtg-folder-branch" data-context-object>
      {nested && <button type="button" className="mtg-folder-toggle" aria-expanded={open} aria-controls={childrenId}
        aria-keyshortcuts="ArrowLeft ArrowRight" aria-description={branchDescription || undefined}
        data-current-folder-branch={hidesSelection || undefined}
        aria-label={tr("{0} folder {1}", [open ? "Collapse" : "Expand", node.label])} onClick={(event) => {
          if (open && document.getElementById(childrenId)?.contains(document.activeElement)) {
            event.currentTarget.focus({ preventScroll: true });
          }
          setOpen(!open);
        }}>
        <ChevronRight className="mtg-folder-chevron" size={13} aria-hidden="true" />
        {node.folders.length === 0 && <><FolderGlyph /><span className="mtg-folder-branch-label">{node.label}</span></>}
        {unreadFolders > 0 && <span className="mtg-folder-branch-unread" aria-hidden="true" />}
      </button>}
      {node.folders.map(({ id, title, color, icon }) => {
        const count = unreadBadges?.get(id);
        return <button className="mtg-folder-select" data-folder-shortcut key={id} type="button" title={title}
          aria-label={title} aria-description={count ? tr("{0} unread", [count]) : undefined} aria-pressed={selected === id}
          data-drop-target={drop?.target === id || undefined} onClick={() => select(id)}
          onDragOver={drop && ((event) => {
            if (!drop.canDrop(id) || !event.dataTransfer.types.includes(chatFolderDragType)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            if (drop.target !== id) drop.highlight(id);
          })}
          onDragLeave={drop && ((event) => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) drop.highlight();
          })}
          onDrop={drop && ((event) => {
            if (!drop.canDrop(id) || !event.dataTransfer.types.includes(chatFolderDragType)) return;
            event.preventDefault();
            drop.highlight();
            drop.add(id);
          })}>
          <FolderGlyph icon={icon} color={color === undefined ? undefined : folderColors[color]?.value} /><span className="mtg-rail-label">{node.label}</span>
          <UnreadListBadge count={count} />
        </button>;
      })}
    </div>
    {nested && <div className="mtg-folder-disclosure" id={childrenId} data-open={open} inert={!open} aria-hidden={!open || undefined}>
      <ul className="mtg-folder-tree mtg-folder-children">
        {node.children.map((child) => <FolderBranch key={child.label} node={child} selected={selected} selectedPath={selectedPath}
          select={select} unreadBadges={unreadBadges} drop={drop} />)}
      </ul>
    </div>}
  </li>;
}

export function FolderNavigation({ folders, selected, select, unreadBadges, drop }: {
  folders: TelegramFolder[];
  drop?: FolderDrop;
  selected: ChatList;
  unreadBadges?: ReadonlyMap<ChatList, number>;
  select: (id: number) => void;
}) {
  const { t: tr } = useTelegramLocale();
  const selectedPath = folders.find(({ id }) => id === selected)?.title;
  return <ul className="mtg-folder-tree" aria-label={tr("Telegram folders")} aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home End"
    onKeyDown={(event) => {
      if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target) || !isPlainKey(event, event.key)) return;
      const button = event.target.closest<HTMLButtonElement>(".mtg-folder-branch button");
      if (!button || button.closest("[inert]")) return;
      const branch = button.closest(".mtg-folder-branch");
      if (!branch) return;
      const toggle = branch.querySelector<HTMLButtonElement>(".mtg-folder-toggle");
      const open = toggle?.getAttribute("aria-expanded") === "true";
      let next: HTMLButtonElement | undefined | null;

      if (event.key === "ArrowRight" && toggle) {
        if (open) next = branch.nextElementSibling?.querySelector<HTMLButtonElement>(".mtg-folder-branch button");
        else {
          toggle.click();
          next = toggle;
        }
      } else if (event.key === "ArrowLeft") {
        if (toggle && open) {
          toggle.click();
          next = toggle;
        } else {
          const parent = branch.parentElement?.parentElement?.closest("li");
          next = parent?.querySelector<HTMLButtonElement>(":scope > .mtg-folder-branch > .mtg-folder-toggle");
        }
      } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        const visible = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".mtg-folder-branch button:enabled"))
          .filter((item) => !item.closest("[inert]"));
        const index = visible.indexOf(button);
        if (event.key === "Home") next = visible[0];
        else if (event.key === "End") next = visible.at(-1);
        else next = visible[index + (event.key === "ArrowDown" ? 1 : -1)];
      }
      if (!next) return;
      event.preventDefault();
      next.focus({ preventScroll: true });
      next.scrollIntoView?.({ block: "nearest" });
    }}>
    {folderTree(folders).map((node) => <FolderBranch key={node.label} node={node} selected={selected} selectedPath={selectedPath}
      select={select} unreadBadges={unreadBadges} drop={drop} />)}
  </ul>;
}
