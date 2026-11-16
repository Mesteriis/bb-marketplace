import { bucketSchema, catalogueEntrySchema, type Source } from "./contract";
import { z } from "zod";

/** One upstream commit between the pin and HEAD. */
export interface Commit {
  sha: string;
  subject: string;
}

export type Bucket = z.output<typeof bucketSchema>;
export type CatalogueEntry = z.output<typeof catalogueEntrySchema>;

export interface SkillStatus {
  name: string;
  bucket: Bucket;
  upstreamBucket: string;
  substantiveFiles: string[];
  cosmeticFiles: string[];
  localEditedFiles: string[];
}

export interface SourceStatus {
  sourceId: string;
  pinned: string | null;
  head: string;
  commits: Commit[];
  skills: SkillStatus[];
  foreign: string[];
  catalogue: CatalogueEntry[];
  fetchedAt: number | null;
  /** Configured auto-fetch interval in hours, 0 when off. */
  autoFetchHours: number;
}

/** Where a skill sits inside a materialised upstream tree. */
export interface UpstreamSkill {
  name: string;
  /** Repo bucket directory, "" for a flat layout. */
  bucket: string;
  /** Absolute path of the skill folder inside the materialised tree. */
  dir: string;
}

/** The two materialised trees plus the git facts a status needs. */
export interface Prepared {
  source: Source;
  /** Plugin-owned cache root used for recoverable apply backups. */
  cacheRoot: string;
  repoDir: string;
  head: string;
  pinned: string | null;
  /** Materialised P tree root, null when the marker is missing. */
  pinDir: string | null;
  /** Materialised H tree root. */
  headDir: string;
  commits: Commit[];
  /** Last successful clone/fetch timestamp, read from the cache sidecar. */
  fetchedAt: number | null;
}
