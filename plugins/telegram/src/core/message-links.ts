import type { LocationPoint } from "./contract.ts";

export type MessageLink = { offset: number; length: number; url: string; hidden?: boolean; instantView?: true };

export function textWebLinks(text: string): URL[] {
  const links: URL[] = [];
  for (const [value] of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const link = webLink(value);
    if (link) links.push(link);
  }
  return links;
}

export function hasWebLink(text: string): boolean {
  return textWebLinks(text).length > 0;
}

export function webLink(value: string): URL | undefined {
  if (!/^https?:\/\//i.test(value) || value.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  try {
    const url = new URL(value);
    if (url.hostname && !url.username && !url.password) return url;
  } catch {
    return;
  }
}

export function articleContactLink(value: string): URL | undefined {
  if (/[\s\p{Cc}\p{Cf}]/u.test(value)) return;
  if (/^mailto:[a-z0-9.!$&'*+=^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(value) && value.length <= 261) {
    return new URL(value);
  }
  if (/^tel:\+?[0-9]{3,32}$/.test(value)) return new URL(value);
}


export function openStreetMapLink({ latitude, longitude }: LocationPoint, zoom = 16): string {
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=${zoom}/${latitude}/${longitude}`;
}
