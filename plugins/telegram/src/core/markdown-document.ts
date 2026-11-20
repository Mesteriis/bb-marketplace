export const maxMarkdownDocumentBytes = 128 * 1024;

export function isMarkdownDocument(name: string) {
  return /\.(?:md|markdown)$/i.test(name);
}

export function isPlainTextDocument(name: string) {
  return /\.(?:txt|log|csv|tsv|json|yaml|yml|xml|ini|toml)$/i.test(name);
}
