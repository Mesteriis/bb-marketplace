// An in-memory import book for tests that need the RPC handlers but not the import feature. Not used by server.ts.
import type { CredentialBook } from "../../core/credential.ts";
import { ImportBook, type ImportSource, type ImportStore, type SourceReader } from "../../core/import-book.ts";
import type { ImportLink } from "../../core/import-plan.ts";
import type { ProfileBook } from "../../core/profile-book.ts";

export class MemoryImportStore implements ImportStore {
  src = new Map<string, ImportSource>();
  lk = new Map<string, ImportLink>();
  sources = () => [...this.src.values()];
  putSource = (s: ImportSource) => void this.src.set(s.id, s);
  removeSource = (id: string) => this.src.delete(id);
  links = (sourceId?: string) => [...this.lk.values()].filter((l) => sourceId === undefined || l.sourceId === sourceId);
  putLink = (l: ImportLink) => void this.lk.set(l.sourceId + ":" + l.key, l);
  removeLinksOfSource = (id: string) => [...this.lk.keys()].filter((k) => k.startsWith(id + ":")).forEach((k) => this.lk.delete(k));
}

export const emptyReader: SourceReader = {
  home: () => "/home/fixture",
  readText: () => null,
  listDir: () => null,
  include: () => ({ files: [], complete: true }),
  agentList: async () => null,
  sshG: async () => null,
};

export function memoryImportBook(profiles: ProfileBook, credentials: CredentialBook, reader: SourceReader = emptyReader): ImportBook {
  let n = 0;
  return new ImportBook({ store: new MemoryImportStore(), reader, profiles, credentials, newId: () => `src-${++n}` });
}
