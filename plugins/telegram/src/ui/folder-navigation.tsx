import { folderColors } from "./folder-colors.ts";
import { FolderGlyph } from "./folder-glyph.tsx";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ChatList, TelegramFolder } from "../core/contract.ts";
import { folderTree, type FolderNode } from "../core/folder-tree.ts";

function FolderBranch({ node, selected, select }: {
  node: FolderNode;
  selected: ChatList;
  select: (id: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const nested = node.children.length > 0;
  const Chevron = open ? ChevronDown : ChevronRight;
  return <li>
    <div className="mtg-folder-branch">
      {nested && <button type="button" className="mtg-folder-toggle" aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} folder ${node.label}`} onClick={() => setOpen(!open)}>
        <Chevron size={13} aria-hidden="true" />{node.folders.length === 0 && <span>{node.label}</span>}
      </button>}
      {node.folders.map(({ id, title, color, icon }) => <button className="mtg-folder-select" key={id} type="button" title={title}
        aria-label={title} aria-pressed={selected === id} onClick={() => select(id)}>
        <FolderGlyph icon={icon} color={color === undefined ? undefined : folderColors[color]?.value} /><span>{node.label}</span>
      </button>)}
    </div>
    {nested && open && <ul className="mtg-folder-tree mtg-folder-children">
      {node.children.map((child) => <FolderBranch key={child.label} node={child} selected={selected} select={select} />)}
    </ul>}
  </li>;
}

export function FolderNavigation({ folders, selected, select }: {
  folders: TelegramFolder[];
  selected: ChatList;
  select: (id: number) => void;
}) {
  return <ul className="mtg-folder-tree">
    {folderTree(folders).map((node) => <FolderBranch key={node.label} node={node} selected={selected} select={select} />)}
  </ul>;
}
