import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js";
import { expect, test } from "vitest";
import { prepareAttachmentArchive } from "../src/ui/archive-attachment.tsx";

function directory(name: string, children: FileSystemEntry[]): FileSystemEntry {
  return { name, isFile: false, isDirectory: true, createReader: () => {
    let current = 0;
    return { readEntries: (ready: (entries: FileSystemEntry[]) => void) => {
      ready(children.slice(current, current + 1));
      current++;
    } };
  } } as unknown as FileSystemDirectoryEntry;
}

function fileEntry(file: File): FileSystemEntry {
  return { name: file.name, isFile: true, isDirectory: false,
    file: (ready: (value: File) => void) => ready(file) } as unknown as FileSystemFileEntry;
}

test("prepares a ZIP with the directory tree, empty folders, and exact source bytes", async () => {
  const signal = new AbortController().signal;
  const source = directory("Reports", [
    directory("Empty", []),
    directory("Итоги", [fileEntry(new File(["содержимое"], "notes.txt"))]),
  ]);
  const archive = await prepareAttachmentArchive([source], signal);
  expect(archive.name).toBe("Reports.zip");
  expect(archive.type).toBe("application/zip");
  const zip = new ZipReader(new BlobReader(archive));
  try {
    const entries = await zip.getEntries();
    expect(entries.map(({ filename }) => filename)).toEqual(["Reports/", "Reports/Empty/", "Reports/Итоги/", "Reports/Итоги/notes.txt"]);
    const notes = entries.find((entry) => !entry.directory);
    if (!notes || notes.directory) throw new Error("ZIP test file is missing.");
    expect(await notes.getData(new TextWriter())).toBe("содержимое");
  } finally { await zip.close(); }
});

test("prepares a ZIP from separate files and rejects unsafe, duplicate or cancelled input", async () => {
  const controller = new AbortController();
  const one = new File(["one"], "one.txt");
  const second = new File(["two"], "two.txt");
  const archive = await prepareAttachmentArchive([one, second], controller.signal);
  expect(archive.name).toBe("Archive.zip");
  const zip = new ZipReader(new BlobReader(archive));
  try {
    expect((await zip.getEntries()).map(({ filename }) => filename)).toEqual(["one.txt", "two.txt"]);
  } finally { await zip.close(); }
  await expect(prepareAttachmentArchive([one, new File(["other"], "ONE.TXT")], controller.signal)).rejects.toThrow("same name");
  await expect(prepareAttachmentArchive([directory("..", [])], controller.signal)).rejects.toThrow("safely");
  await expect(prepareAttachmentArchive([directory(".. ", [])], controller.signal)).rejects.toThrow("safely");
  controller.abort();
  await expect(prepareAttachmentArchive([one], controller.signal)).rejects.toHaveProperty("name", "AbortError");
});
