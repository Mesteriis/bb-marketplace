import type { CollectionPort } from "../../core/collection";
import type { CollectionWritePort, ThreadsPort } from "../../core/review";

/** Stand-ins for adapters whose setting is empty: every call fails with the error naming the setting. */
export function unconfiguredCollection(error: () => Error): CollectionPort {
  return {
    readIndex: async () => Promise.reject(error()),
    readFile: async () => Promise.reject(error()),
    isAccepted: async () => Promise.reject(error()),
    sameEntryAt: async () => Promise.reject(error()),
  };
}

export function unconfiguredWrite(error: () => Error): CollectionWritePort {
  return {
    branchHasEntry: async () => Promise.reject(error()),
    accept: async () => Promise.reject(error()),
    reject: async () => Promise.reject(error()),
  };
}

export function unconfiguredThreads(error: () => Error): ThreadsPort {
  return {
    spawnReview: async () => Promise.reject(error()),
    info: async () => Promise.reject(error()),
  };
}
