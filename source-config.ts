import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { sourceSchema, type Source } from "./contract";

export const DEFAULT_SOURCES = JSON.stringify(
  [
    {
      id: "mattpocock",
      url: "https://github.com/mattpocock/skills.git",
      ref: "HEAD",
      skillsDir: "skills",
      nested: true,
      skipBuckets: ["in-progress", "deprecated"],
      installRoot: path.join(os.homedir(), ".agents", "skills"),
      marker: ".mattpocock-skills-version",
    },
  ],
  null,
  2,
);

const sourcesSchema = z.array(sourceSchema).min(1);

export type ParsedSources =
  | { ok: true; sources: Source[] }
  | { ok: false; message: string };

/**
 * Parse the `sources` setting without ever throwing: a malformed value must
 * put the plugin in `needs-configuration`, not kill the factory.
 */
export function parseSources(
  raw: string | undefined,
  defaultSources = DEFAULT_SOURCES,
): ParsedSources {
  const text = (raw ?? "").trim();
  if (text === "") {
    return {
      ok: false,
      message:
        'The "sources" setting is empty. Set it to a JSON array of sources, e.g. ' +
        `${defaultSources.replace(/\s+/g, " ")}`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      message:
        `The "sources" setting is not valid JSON (${error instanceof Error ? error.message : String(error)}).` +
        " Fix it with `bb plugin config skills-sync`, then reload the plugin.",
    };
  }
  const parsed = sourcesSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map(
        (issue) =>
          `sources${issue.path.length > 0 ? `.${issue.path.join(".")}` : ""}: ${issue.message}`,
      )
      .join("; ");
    return {
      ok: false,
      message: `The "sources" setting does not match the source schema — ${issues}. Fix it with \`bb plugin config skills-sync\`, then reload the plugin.`,
    };
  }
  const seen = new Set<string>();
  for (const source of parsed.data) {
    if (seen.has(source.id)) {
      return { ok: false, message: `Duplicate source id "${source.id}" in the "sources" setting.` };
    }
    seen.add(source.id);
    if (!path.isAbsolute(source.installRoot)) {
      return {
        ok: false,
        message: `Source "${source.id}" has a relative installRoot ("${source.installRoot}"); it must be an absolute path.`,
      };
    }
  }
  return { ok: true, sources: parsed.data };
}
