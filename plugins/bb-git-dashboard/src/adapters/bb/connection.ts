import { detectProvider, type ConnectionInput } from "../../core/connection.ts";
import { account } from "../../core/providers.ts";
import { forgePrefix } from "./forge-provider.ts";
import { client, object, originOf, text } from "./provider-http.ts";
import { provider } from "./provider.ts";

export async function checkConnection(input:ConnectionInput,id:string,send:typeof fetch = fetch) {
  const {token, ...metadata} = input;
  const detected = detectProvider(metadata.origin);
  if (!detected || (detected.kind && detected.kind !== metadata.kind) ||
      (metadata.kind === "azure" && (!metadata.organization || !metadata.username))) throw new Error("INVALID_INPUT");
  const draft = account.safeParse({...metadata,id,username:metadata.username || "pending"});
  if (!draft.success) throw new Error("INVALID_INPUT");
  originOf(draft.data);
  const transport = client(draft.data, token, send);
  let username = metadata.username;
  if (metadata.kind !== "azure") {
    const {payload} = await transport(forgePrefix(draft.data) + "/user");
    username = text(object(payload).login) || text(object(payload).username);
    if (!username) throw new Error("PROVIDER_DENIED");
  }
  const selected = account.safeParse({...draft.data,username});
  if (!selected.success) throw new Error("PROVIDER_DENIED");
  const result = await provider(selected.data,token,send).repositories(1);
  return {account:selected.data,username, repositories:result.items.map(repo => repo.path), hasMore:result.more};
}
