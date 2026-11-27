import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { defaultExclude, defaultProjectsRoot, parseExclude, summarize } from "../../core/catalog/project-scan.ts";
import { projectTree } from "../../core/catalog/project-tree.ts";
import { failureFor } from "../../core/workspace.ts";
import { hostContract } from "./host-contract.ts";

/** The projects folder setting and the preview of which folders count as projects. */
export function projectCatalog(bb: BbPluginApi) {
  const settings = bb.settings.define({
    projectsRoot: {type: "string", label: "Projects folder", default: defaultProjectsRoot},
    projectExclude: {type: "string", label: "Folders skipped while looking for projects (comma-separated names; hidden folders are always skipped)", default: defaultExclude},
  });
  const host = bb.hosts.experimental_client({contract: hostContract});
  return {
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
