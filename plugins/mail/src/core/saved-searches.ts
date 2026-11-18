// Saved searches (slice 3h, #63): a name and a query the rail keeps. Pure.

export const SAVED_SEARCHES_MAX = 50;
export const SAVED_SEARCH_NAME_MAX = 60;
/** The same bound as the search query. */
export const SAVED_SEARCH_QUERY_MAX = 500;

const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** A saved search's name (1-60 characters, no control characters) and query (1-500), trimmed. */
export function validSavedSearch(input: {
  name: string;
  query: string;
}): { ok: true; name: string; query: string } | { ok: false; reason: "name" | "query" } {
  const name = input.name.replace(CONTROLS, "").trim();
  if (name === "" || name.length > SAVED_SEARCH_NAME_MAX) return { ok: false, reason: "name" };
  const query = input.query.trim();
  if (query === "" || query.length > SAVED_SEARCH_QUERY_MAX) return { ok: false, reason: "query" };
  return { ok: true, name, query };
}
