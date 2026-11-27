import type { Issues } from "../../../../core/issues/model.ts";
import type { Account } from "../../../../core/providers.ts";
import { array, client, object, text } from "../../provider-http.ts";
import { gitlabProject } from "../gitlab-provider.ts";
import { ownLink } from "../inbox/shared.ts";
import { repoParts } from "../review/shared.ts";

/** Issues of a GitLab project; notes GitLab writes itself are left out. */
export function gitlabIssues(account: Account, token: string, path: string, send: typeof fetch = fetch): Issues {
  repoParts(path, true);
  const http = client(account, token, send);
  const base = gitlabProject(path) + "/issues";
  return {
    async detail(number) {
      const [raw, notes] = await Promise.all([http(base + "/" + number).then(result => object(result.payload)),
        http(base + "/" + number + "/notes?sort=asc&per_page=100").then(result => array(result.payload).map(object))]);
      return {number, title: text(raw.title), body: text(raw.description), open: raw.state === "opened", author: text(object(raw.author).username) || "ghost",
        labels: array(raw.labels).map(label => typeof label === "string" ? label : text(object(label).name)).filter(Boolean),
        url: ownLink(account, raw.web_url) ?? "", createdAt: text(raw.created_at),
        comments: notes.filter(row => row.system !== true).map(row => ({author: text(object(row.author).username) || "ghost", body: text(row.body),
          createdAt: text(row.created_at), url: ""}))};
    },
    async act(action) {
      if (action.kind === "create") {
        const number = object((await http(base, {method: "POST", body: {title: action.title, description: action.body}})).payload).iid;
        if (!Number.isSafeInteger(number)) throw new Error("OUTCOME_UNKNOWN");
        return {number: number as number};
      }
      if (action.kind === "comment") await http(base + "/" + action.number + "/notes", {method: "POST", body: {body: action.body}});
      else await http(base + "/" + action.number, {method: "PUT", body: {state_event: action.open ? "reopen" : "close"}});
      return {number: action.number};
    },
  };
}
