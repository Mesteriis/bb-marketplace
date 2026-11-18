// The one ordered list of schema statements (bb.storage.migrate numbers them by position): append only, and
// a new statement for an older table goes at the END, never into that table's own array, so a database that
// already ran the earlier statements keeps its numbering.
import { CREDENTIAL_MIGRATIONS } from "./credential-sqlite.ts";
import { IMPORT_MIGRATIONS } from "./import-sqlite.ts";
import { PROFILE_LATER_MIGRATIONS, PROFILE_MIGRATIONS } from "./profile-sqlite.ts";

export const ALL_MIGRATIONS: string[] = [...PROFILE_MIGRATIONS, ...CREDENTIAL_MIGRATIONS, ...IMPORT_MIGRATIONS, ...PROFILE_LATER_MIGRATIONS];
