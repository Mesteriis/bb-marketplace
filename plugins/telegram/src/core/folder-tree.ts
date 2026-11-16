import type { TelegramFolder } from "./contract.ts";

export type FolderNode = {
  label: string;
  folders: TelegramFolder[];
  children: FolderNode[];
};

export function folderTree(folders: readonly TelegramFolder[]): FolderNode[] {
  const root: FolderNode[] = [];
  for (const folder of folders) {
    const parts = folder.title.split(".").map((part) => part.trim());
    let children = root;
    let leaf: FolderNode | undefined;
    for (const label of parts.every(Boolean) ? parts : [folder.title]) {
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
