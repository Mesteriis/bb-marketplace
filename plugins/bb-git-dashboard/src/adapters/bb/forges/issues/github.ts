import type { IssueDetail, Issues } from "../../../../core/issues/model.ts";
import type { Account } from "../../../../core/providers.ts";
import { forgePrefix } from "../../forge-provider.ts";
import { array, client, object, segment, text, type Json } from "../../provider-http.ts";
import { ownLink } from "../inbox/shared.ts";
import { repoParts } from "../review/shared.ts";

/** Issues of a GitHub repository (pull requests, which GitHub also lists as issues, are refused). */
export function githubIssues(account: Account, token: string, path: string, send: typeof fetch = fetch): Issues {
  const [owner, name] = repoParts(path);
  const http = client(account, token, send);
  const base = forgePrefix(account) + "/repos/" + segment(owner) + "/" + segment(name) + "/issues";
  return {
    async detail(number) {
      const [raw, comments] = await Promise.all([http(base + "/" + number).then(result => object(result.payload)),
        http(base + "/" + number + "/comments?per_page=100").then(result => array(result.payload).map(object))]);
      if (raw.pull_request) throw new Error("NOT_FOUND");
      return {number, title: text(raw.title), body: text(raw.body), open: raw.state === "open", author: text(object(raw.user).login) || "ghost",
        labels: array(raw.labels).map(label => typeof label === "string" ? label : text(object(label).name)).filter(Boolean),
        url: ownLink(account, raw.html_url) ?? "", createdAt: text(raw.created_at),
        comments: comments.map((row: Json) => ({author: text(object(row.user).login) || "ghost", body: text(row.body), createdAt: text(row.created_at),
          url: ownLink(account, row.html_url) ?? ""}))} satisfies IssueDetail;
    },
    async act(action) {
      if (action.kind === "create") {
        const number = object((await http(base, {method: "POST", body: {title: action.title, body: action.body}})).payload).number;
        if (!Number.isSafeInteger(number)) throw new Error("OUTCOME_UNKNOWN");
        return {number: number as number};
      }
      if (action.kind === "comment") await http(base + "/" + action.number + "/comments", {method: "POST", body: {body: action.body}});
      else await http(base + "/" + action.number, {method: "PATCH", body: {state: action.open ? "open" : "closed"}});
      return {number: action.number};
    },
  };
}
