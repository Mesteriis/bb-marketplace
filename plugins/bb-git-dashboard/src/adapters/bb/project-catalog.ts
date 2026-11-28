import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { defaultExclude, defaultProjectsRoot, parseExclude, summarize } from "../../core/catalog/project-scan.ts";
import { projectTree } from "../../core/catalog/project-tree.ts";
import { failureFor } from "../../core/workspace.ts";
import { hostContract } from "./host-contract.ts";
import type { SettingsRegistry } from "./settings-rpc.ts";

/** The projects folder setting and the preview of which folders count as projects. */
export function projectCatalog(bb: BbPluginApi, registry?: SettingsRegistry) {
  const settings = bb.settings.define({
    projectsRoot: {type: "string", label: "Projects folder", default: defaultProjectsRoot},
    projectExclude: {type: "string", label: "Folders skipped while looking for projects (comma-separated names; hidden folders are always skipped)", default: defaultExclude},
  });
  // The plugin's settings section writes this module's main settings through its own handle.
  registry?.add("catalog", ["projectsRoot"], values => settings.experimental_set(values as never));
  const host = bb.hosts.experimental_client({contract: hostContract});
  return {
    /** The projects folder and the names the walk skips, as set. */
    async rules() {
      const {projectsRoot, projectExclude} = await settings.get();
      return {root: projectsRoot, exclude: parseExclude(projectExclude)};
    },
    async preview(hostId: string) {
      try {
        const {projectsRoot, projectExclude} = await settings.get();
        const result = await host.call("scanProjects", {root: projectsRoot, exclude: parseExclude(projectExclude)}, {hostId});
        if (!result.ok) return result;
        return {ok: true as const, value: summarize(projectsRoot, result.verdicts, result.truncated), tree: projectTree(result.verdicts)};
      } catch (error) { return failureFor(error, "HOST_UNAVAILABLE"); }
    },
  };
}
