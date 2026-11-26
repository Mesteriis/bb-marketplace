// The slug of an MCP registry server name. The same formula lives in
// plugins/mcp-catalog/src/core/collection.ts (serverSlug); a test in that
// plugin pins both to the same outputs, so a change here must change there too.
export function serverSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
