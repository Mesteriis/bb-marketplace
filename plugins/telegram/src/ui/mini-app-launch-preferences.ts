import type { MiniAppMediaAccess } from "../core/mini-app-media.ts";

export type MiniAppLaunchPreference = { origin: string; media: MiniAppMediaAccess };

export function readMiniAppLaunchPreference(key: string): MiniAppLaunchPreference | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (typeof value?.origin !== "string" || typeof value.media?.camera !== "boolean"
      || typeof value.media?.microphone !== "boolean") return;
    const origin = new URL(value.origin);
    if (origin.protocol === "https:" && origin.origin === value.origin) {
      return { origin: value.origin, media: { camera: value.media.camera, microphone: value.media.microphone } };
    }
  } catch {}
}

export function saveMiniAppLaunchPreference(key: string | undefined, preference: MiniAppLaunchPreference) {
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(preference)); } catch {}
}
