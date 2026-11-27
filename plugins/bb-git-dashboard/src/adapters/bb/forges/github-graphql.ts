import type { Account } from "../../../core/providers.ts";
import { array, object, text, type Http } from "../provider-http.ts";

/** github.com answers at api.github.com/graphql, GitHub Enterprise Server at <origin>/api/graphql. */
export const graphqlPath = (account: Account) => ["github.com", "api.github.com"].includes(new URL(account.origin).hostname) ? "/graphql" : "/api/graphql";

/** A GitHub GraphQL call through the account's client: a read POST, errors without data mapped to codes. */
export function githubGraphql(account: Account, http: Http) {
  return async function graphql<T>(query: string, variables: Record<string, unknown> = {}, write = false): Promise<T> {
    const {payload} = await http(graphqlPath(account), {method: "POST", read: !write, maxBytes: 8 * 1024 * 1024, body: {query, variables}});
    const answer = object(payload);
    const errors = array(answer.errors).map(object);
    if (errors.length && (!answer.data || write)) {
      throw new Error(errors.some(error => ["FORBIDDEN", "INSUFFICIENT_SCOPES"].includes(text(error.type))) ? "PROVIDER_DENIED"
        : errors.some(error => text(error.type) === "NOT_FOUND") ? "NOT_FOUND" : "PROVIDER_REJECTED");
    }
    return answer.data as T;
  };
}
