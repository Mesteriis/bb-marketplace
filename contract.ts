import { defineRpcContract } from "@get-bb/plugin-sdk";
import { isSinglePathSegment } from "./path-safety";
import { z } from "zod";

/** One upstream skills repository the user syncs from. */
export const sourceSchema = z
  .object({
    /** Stable id; namespaces the marker file and CLI arguments. */
    id: z.string().min(1),
    /** Clone URL. */
    url: z.string().min(1),
    /** Git ref to track. */
    ref: z.string().default("HEAD"),
    /** Directory inside the repo holding skills. */
    skillsDir: z.string().default("skills"),
    /**
     * true  -> skills live at <skillsDir>/<bucket>/<name> (mattpocock's layout)
     * false -> skills live at <skillsDir>/<name>
     */
    nested: z.boolean().default(true),
    /** Buckets never offered for install, e.g. ["in-progress"]. */
    skipBuckets: z.array(z.string()).default([]),
    /** Absolute path the skills are installed into. */
    installRoot: z.string().min(1),
    /** Marker filename inside installRoot holding the pinned commit SHA. */
    marker: z.string().min(1).refine(isSinglePathSegment, {
      message: "must be a single filename inside installRoot",
    }),
  })
  .strict();

export type Source = z.output<typeof sourceSchema>;

/** Which of the five buckets a skill falls into. */
export const bucketSchema = z.enum([
  /** in HEAD, absent from both pin and local: never installed */
  "new",
  /** in pin and local, gone from HEAD or moved under a deprecated bucket */
  "deprecated",
  /** local matches pin, HEAD moved: safe to overwrite */
  "clean",
  /** local differs from pin AND HEAD moved: needs a hand merge */
  "dirty-conflict",
  /** local differs from pin, HEAD untouched: nothing to decide */
  "dirty-only",
]);

export const skillStatusSchema = z
  .object({
    name: z.string(),
    bucket: bucketSchema,
    /** Repo bucket directory the skill sits in upstream, "" when flat. */
    upstreamBucket: z.string(),
    /** Files whose upstream change survives punctuation normalisation. */
    substantiveFiles: z.array(z.string()),
    /** Files whose upstream change is punctuation/quoting only. */
    cosmeticFiles: z.array(z.string()),
    /** Files the user edited locally, relative to the skill folder. */
    localEditedFiles: z.array(z.string()),
  })
  .strict();

/**
 * An upstream skill the user could install but has not. This is a browsing
 * surface, not a work list: it exists so a skill declined once can be found
 * again later. Buckets the user excluded via `skipBuckets` are NOT here —
 * excluded means excluded, in every view.
 */
export const catalogueEntrySchema = z
  .object({
    name: z.string(),
    /** Repo bucket directory the skill sits in upstream, "" when flat. */
    upstreamBucket: z.string(),
    /**
     * The `description` field from the skill's SKILL.md frontmatter, or "" when
     * the file has no parsable frontmatter. Never invented.
     */
    description: z.string(),
    /**
     * True when this skill is also reported in the `new` bucket, i.e. it is
     * news. False means the user has seen it before and did not install it;
     * it stays listed so the decision can be revisited, but it is never
     * selected by default and never counted as outstanding work.
     */
    offered: z.boolean(),
  })
  .strict();

export const statusSchema = z
  .object({
    sourceId: z.string(),
    /** Pinned SHA from the marker file, null when the marker is missing. */
    pinned: z.string().nullable(),
    head: z.string(),
    /** Upstream commits between pin and HEAD, newest first. */
    commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
    skills: z.array(skillStatusSchema),
    /** Local folders with no upstream match: other origins, never touched. */
    foreign: z.array(z.string()),
    /** Installable upstream skills at HEAD with no local folder. Browsing only. */
    catalogue: z.array(catalogueEntrySchema),
    /**
     * When the cached clone last ran `git fetch`, as epoch milliseconds, or
     * null when it has never fetched since being cloned. The UI must show this:
     * `head` is only as current as this timestamp, and a cached SHA presented
     * as a live one is the whole reason this field exists.
     */
    fetchedAt: z.number().nullable(),
    /**
     * The configured auto-fetch interval in hours, 0 when auto-fetch is off.
     * The UI needs it to judge staleness: a cache six hours old is normal under
     * a six-hourly schedule and alarming under an hourly one, so a fixed
     * threshold would either cry wolf or stay silent when it mattered.
     */
    autoFetchHours: z.number().int().min(0),
  })
  .strict();

type ApplyBackup = { name: string; path: string };
type ApplyRpcOutput = {
  applied: string[];
  failed: Array<{ name: string; error: string }>;
  backups: ApplyBackup[];
  markerRefusal: string | null;
  marker: string | null;
};
type ApplyRpcCompatibleOutput = Omit<ApplyRpcOutput, "backups"> & {
  /** Compatibility for frontend test handlers during the contract rollout. */
  backups?: ApplyBackup[];
};

const applyOutputSchema = z.object({
  applied: z.array(z.string()),
  /** Per-skill failures only. A marker refusal is not a skill failure. */
  failed: z.array(z.object({ name: z.string(), error: z.string() })),
  /** Recoverable copies made before local edits were overwritten. */
  backups: z.array(z.object({ name: z.string(), path: z.string() })),
  /**
   * Why the marker was not bumped, or null when no refusal happened
   * (either it was bumped, or the caller never asked).
   */
  markerRefusal: z.string().nullable(),
  marker: z.string().nullable(),
});


/**
 * Where an agent-assisted merge has got to.
 *
 * `ready` means a merged copy is staged and waiting for the user to look at it.
 * Nothing is ever written to the skills folder by the merge itself: staging is
 * the whole safety property, and `accept` is the only thing that writes.
 */
export const mergeStateSchema = z.enum([
  /** No merge has been started for this skill. */
  "none",
  /** A thread is working, or is waiting on an answer from the user. */
  "running",
  /** A merged copy is staged and can be reviewed. */
  "ready",
  /** The agent stopped without producing a merge. The local skill is untouched. */
  "failed",
]);

export const mergeSchema = z
  .object({
    state: mergeStateSchema,
    /**
     * The bb thread doing the merge, so the panel can show the conversation and
     * the user can answer its questions. Null before one is spawned.
     */
    threadId: z.string().nullable(),
    /**
     * Absolute path of the staged merge, inside the plugin cache. Never inside
     * the skills folder: a half-merged skill sitting there would be read as a
     * real skill by every agent on this machine.
     */
    stagingDir: z.string().nullable(),
    /** Why the merge failed, in the agent's own words. Null unless failed. */
    error: z.string().nullable(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  listSources: {
    input: z.null(),
    output: z.object({ sources: z.array(sourceSchema) }),
  },
  status: {
    input: z.object({ sourceId: z.string(), refresh: z.boolean().default(false) }).strict(),
    output: statusSchema,
  },
  diff: {
    input: z
      .object({
        sourceId: z.string(),
        name: z.string(),
        /** "upstream" = pin..HEAD, "local" = pin..installed */
        kind: z.enum(["upstream", "local"]),
      })
      .strict(),
    output: z.object({ patch: z.string() }),
  },
  /**
   * Hand a conflicted skill to an agent in a bb thread. Returns immediately
   * with the thread; the merge itself is not awaited.
   */
  mergeStart: {
    input: z.object({ sourceId: z.string(), name: z.string() }).strict(),
    output: mergeSchema,
  },
  mergeState: {
    input: z.object({ sourceId: z.string(), name: z.string() }).strict(),
    output: mergeSchema,
  },
  /** The staged merge against what is installed now, so the user sees what changes. */
  mergeDiff: {
    input: z.object({ sourceId: z.string(), name: z.string() }).strict(),
    output: z.object({ patch: z.string() }),
  },
  /**
   * Write a staged merge into the skills folder. This is destructive in the
   * same way `apply --overwrite-edits` is, and carries the same guarantee:
   * the existing local copy is backed up first, and a failed backup aborts
   * the write rather than proceeding without a safety net.
   */
  mergeAccept: {
    input: z.object({ sourceId: z.string(), name: z.string() }).strict(),
    output: z.object({
      /** Where the pre-merge local copy was saved. */
      backup: z.string(),
    }),
  },
  /**
   * Stop a running merge and throw away whatever it had staged.
   *
   * Cancelling is always safe: nothing reaches the skills folder before the
   * user accepts, so there is no half-written state to undo. The skill returns
   * to being an unresolved conflict, exactly as it was before the merge began.
   *
   * `ok` is only ever returned when the whole cancel happened: the staged bytes
   * are gone AND every merge thread was stopped and archived. If the agent
   * could not be stopped, this throws instead, because the caller's next words
   * to the user are "the agent is stopped" and the staged files it may still
   * rewrite have just been deleted. The output stays `{ ok: true }` rather than
   * gaining a "partly cancelled" field precisely so that no caller can read
   * past a half-done cancel by accident.
   */
  mergeCancel: {
    input: z.object({ sourceId: z.string(), name: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  /** Throw the staged merge away. Never touches the skills folder. */
  mergeDiscard: {
    input: z.object({ sourceId: z.string(), name: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  apply: {
    input: z
      .object({
        sourceId: z.string(),
        /** Explicit skill names to install or overwrite. Never a glob. */
        names: z.array(z.string()),
        /** Write the new SHA only when every name lands and no work remains. */
        bumpMarker: z.boolean().default(false),
        /**
         * Overwrite a `dirty-conflict` skill, destroying the user's local edit.
         * Off by default: the bucket exists precisely to stop this happening by
         * accident. A caller sets it only on an explicit, informed instruction
         * ("take upstream, drop my changes"), never as a convenience.
         */
        allowConflictOverwrite: z.boolean().default(false),
      })
    .strict(),
    // The concrete schema requires backups at the wire boundary. The cast
    // only keeps the static app/test result type compatible while old
    // frontend handlers migrate; the backend always returns the field.
    output: applyOutputSchema as unknown as z.ZodType<
      ApplyRpcCompatibleOutput,
      ApplyRpcCompatibleOutput
    >,
  },
});
