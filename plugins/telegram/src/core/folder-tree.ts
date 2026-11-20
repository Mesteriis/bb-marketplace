import type { TelegramFolder } from "./contract.ts";

export type FolderNode = {
  label: string;
  folders: TelegramFolder[];
  children: FolderNode[];
};

export function folderTitleParts(title: string): string[] {
  const parts = title.split(".").map((part) => part.trim());
  return parts.every(Boolean) ? parts : [title];
}

export function folderTree(folders: readonly TelegramFolder[]): FolderNode[] {
  const root: FolderNode[] = [];
  for (const folder of folders) {
    let children = root;
    let leaf: FolderNode | undefined;
    for (const label of folderTitleParts(folder.title)) {
      leaf = children.find((node) => node.label === label);
      if (!leaf) {
        leaf = { label, folders: [], children: [] };
        children.push(leaf);
      }
      children = leaf.children;
    }
    leaf?.folders.push(folder);
  }
  return root;
}

export function folderChoices(folders: readonly TelegramFolder[]) {
  function choices(nodes: readonly FolderNode[], prefix = ""): { id: number; label: string }[] {
    return nodes.flatMap(({ label, folders, children }) => {
      const path = prefix ? `${prefix} / ${label}` : label;
      return [
        ...folders.map(({ id }) => ({ id, label: folders.length > 1 ? `${path} · ID ${id}` : path })),
        ...choices(children, path),
      ];
    });
  }
  return choices(folderTree(folders));
}

export function folderParentPaths(folders: readonly TelegramFolder[], original: string): string[] {
  const ownPath = folderTitleParts(original).join(".");
  const paths = new Set<string>();
  for (const { title } of folders) {
    const parts = folderTitleParts(title);
    for (let depth = 1; depth <= parts.length; depth++) {
      const parent = parts.slice(0, depth).join(".");
      if (parent.length > 10 || parent.split(".").some((part) => !part) || (ownPath &&
        (parent === ownPath || parent.startsWith(`${ownPath}.`)))) continue;
      paths.add(parent);
    }
  }
  return [...paths];
}
