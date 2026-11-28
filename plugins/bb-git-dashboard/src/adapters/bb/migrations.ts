import { REVIEW_MIGRATIONS } from "./review-store.ts";
import { SCAFFOLD_CACHE_MIGRATIONS } from "./scaffold-cache.ts";

/**
 * The migrations of the plugin's one database, in order. The host numbers the statements of this whole list, so a
 * statement keeps its place forever: the review's list is closed at its 18 statements, and every new statement of
 * any part is appended at the end here.
 */
export const PLUGIN_MIGRATIONS: string[] = [...REVIEW_MIGRATIONS, ...SCAFFOLD_CACHE_MIGRATIONS];
