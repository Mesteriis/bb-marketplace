// Keeps the embedded-mode choice in this BB client's own storage.
import type { ConsentStorage } from "../../core/consent.ts";

export function createLocalConsentStorage(target: Window = window): ConsentStorage {
  return {
    get: (key) => target.localStorage.getItem(key),
    set: (key, value) => target.localStorage.setItem(key, value),
    remove: (key) => target.localStorage.removeItem(key),
    onExternalChange(listener) {
      const onStorage = () => listener();
      target.addEventListener("storage", onStorage);
      return () => target.removeEventListener("storage", onStorage);
    },
  };
}
