export type MessageLink = { offset: number; length: number; url: string; hidden?: boolean };

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
