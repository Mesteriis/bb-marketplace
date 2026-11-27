import { isLanguage, type LanguageId } from "../../core/highlight/plan.ts";
import { grammars } from "./grammars.ts";

type Ask = {req: {query(name: string): string | undefined}};
const load = async (id: LanguageId) => (await grammars[id]()).default;

/**
 * GET /grammar?id=<language>: one Shiki grammar, with the grammars it embeds, as JSON. The app's highlighter asks for
 * it when it first shows a diff in that language; the browser keeps it for a day.
 */
export function grammarRoute(read: (id: LanguageId) => Promise<unknown> = load) {
  return async (context: Ask): Promise<Response> => {
    const id = context.req.query("id") ?? "";
    if (!isLanguage(id)) return new Response("Unknown language.", {status: 404});
    try {
      return new Response(JSON.stringify(await read(id)), {headers: {"content-type": "application/json", "cache-control": "private, max-age=86400"}});
    } catch {
      return new Response("The grammar could not be loaded.", {status: 500});
    }
  };
}
