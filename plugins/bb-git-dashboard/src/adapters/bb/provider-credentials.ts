import { createHash } from "node:crypto";
import { z } from "zod";
import type { Account } from "../../core/providers.ts";
import { originOf } from "./provider-http.ts";

const value = z.string().min(1).max(131072).regex(/^[^\r\n]+$/);
const envelope = z.object({version:z.literal(1),binding:z.string(),token:value});
export type CredentialState = {binding:string;mode:"backup"|"vault"|"revoked"};
type Vault = {
  enabled(signal?:AbortSignal):Promise<boolean>;
  get(ref:string,signal?:AbortSignal):Promise<string|null>;
  putIfAbsent(ref:string,secret:string,signal?:AbortSignal):Promise<void>;
};
type StateStore = {
  get(id:string):Promise<CredentialState|undefined>;
  set(id:string,state:CredentialState):Promise<void>;
};
type Backup = () => string|undefined;

export function providerCredentials(vault:Vault, states:StateStore) {
  async function vaultCall<T>(action:()=>Promise<T>) {
    try { return await action(); }
    catch { throw new Error("CREDENTIAL_VAULT_UNAVAILABLE"); }
  }
  function builtIn(read:Backup) {
    const token = value.safeParse(read());
    if (!token.success) throw new Error("ACCOUNT_UNCONFIGURED");
    return token.data;
  }
  return {
    async resolve(account:Account, readBackup:Backup, signal?:AbortSignal) {
      const binding = createHash("sha256").update(JSON.stringify([
        account.id,account.kind,originOf(account),account.organization.toLowerCase(),account.username,
      ])).digest("hex");
      const ref = "bb-git-dashboard:provider:v1:" + createHash("sha256").update(account.id).digest("hex");
      const state = await states.get(account.id);
      if (state && state.binding !== binding) throw new Error("CREDENTIAL_BINDING_CHANGED");
      if (!await vaultCall(() => vault.enabled(signal))) {
        if (state?.mode === "revoked") throw new Error("CREDENTIAL_VAULT_MISSING");
        const token = builtIn(readBackup);
        if (!state) await states.set(account.id,{binding,mode:"backup"});
        return token;
      }

      let raw = await vaultCall(() => vault.get(ref,signal));
      if (raw === null) {
        if (state?.mode === "vault" || state?.mode === "revoked") {
          if (state.mode !== "revoked") await states.set(account.id,{binding,mode:"revoked"});
          throw new Error("CREDENTIAL_VAULT_MISSING");
        }
        const secret = JSON.stringify({version:1,binding,token:builtIn(readBackup)});
        await vaultCall(() => vault.putIfAbsent(ref,secret,signal));
        raw = await vaultCall(() => vault.get(ref,signal));
        if (raw === null) throw new Error("CREDENTIAL_VAULT_UNAVAILABLE");
      }
      const parsed = decodeEnvelope(raw);
      if (!parsed || parsed.binding !== binding) throw new Error("CREDENTIAL_BINDING_CHANGED");
      if (state?.mode !== "vault") await states.set(account.id,{binding,mode:"vault"});
      return parsed.token;
    },
  };
}

function decodeEnvelope(raw:string) {
  try {
    const parsed = envelope.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
