// The one ordered list of schema statements (bb.storage.migrate numbers them by position): append only, and
// a new statement for an older table goes at the END, never into that table's own array, so a database that
// already ran the earlier statements keeps its numbering.
import { CREDENTIAL_MIGRATIONS } from "./credential-sqlite.ts";
import { IMPORT_MIGRATIONS } from "./import-sqlite.ts";
import { RDP_TRUST_MIGRATIONS } from "./rdp-trust-sqlite.ts";
import { AGENT_MIGRATIONS } from "./agent-sqlite.ts";
import { PROFILE_LATER_MIGRATIONS, PROFILE_MIGRATIONS } from "./profile-sqlite.ts";

/**
 * An alias imported before `needs_config` existed has the column at 0 although its import link says it was never
 * resolved: it could be given a password that is not tied to where it really goes. Backfill from those links.
 */
export const NEEDS_CONFIG_BACKFILL: string[] = [`UPDATE profiles SET needs_config = 1 WHERE id IN (SELECT profile_id FROM import_links WHERE resolved = 0);`];

export const ALL_MIGRATIONS: string[] = [...PROFILE_MIGRATIONS, ...CREDENTIAL_MIGRATIONS, ...IMPORT_MIGRATIONS, ...PROFILE_LATER_MIGRATIONS, ...RDP_TRUST_MIGRATIONS, ...NEEDS_CONFIG_BACKFILL, ...AGENT_MIGRATIONS];
