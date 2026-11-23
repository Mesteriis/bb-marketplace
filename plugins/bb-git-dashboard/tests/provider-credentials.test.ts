import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import { providerCredentials, type CredentialState } from "../src/adapters/bb/provider-credentials.ts";
import type { Account } from "../src/core/providers.ts";

const account:Account = {kind:"github",id:"existing-account",label:"Example",username:"alice",origin:"https://github.com",organization:""};
const legacy = () => "synthetic-legacy-token";
const evil = () => { throw new Error("must not consult fallback"); };

function fixture() {
  let enabled = true;
  let unavailable = false;
  const records = new Map<string,string>();
  const states = new Map<string,CredentialState>();
  const calls:string[] = [];
  const resolver = providerCredentials({
    async enabled() {calls.push("status");return enabled;},
    async get(ref) {
      calls.push("get");
      if (unavailable) throw new Error("secret must not appear in errors");
      return records.get(ref) ?? null;
    },
    async putIfAbsent(ref,secret) {
      calls.push("put");
      if (!records.has(ref)) records.set(ref,secret);
    },
  },{
    async get(id) {return states.get(id);},
    async set(id,state) {states.set(id,state);},
  });
  return {resolver,records,states,calls,enable:(value:boolean) => {enabled=value;},lock:() => {unavailable=true;}};
}

test("migrates on first use, verifies the Vault record, falls back only while disabled", async () => {
  const f = fixture();
  equal(await f.resolver.resolve(account,legacy),"synthetic-legacy-token");
  deepEqual(f.calls,["status","get","put","get"]);
  equal(f.states.get(account.id)?.mode,"vault");
  equal(await f.resolver.resolve(account,evil),"synthetic-legacy-token");
  f.enable(false);
  equal(await f.resolver.resolve(account,legacy),"synthetic-legacy-token");
  equal(f.calls.at(-1),"status");
  f.enable(true);
  equal(await f.resolver.resolve(account,evil),"synthetic-legacy-token");
});

test("enabling Vault migrates a previously resolved built-in token", async () => {
  const f = fixture();
  f.enable(false);
  equal(await f.resolver.resolve(account,legacy),"synthetic-legacy-token");
  equal(f.states.get(account.id)?.mode,"backup");
  equal(f.records.size,0);
  f.enable(true);
  equal(await f.resolver.resolve(account,legacy),"synthetic-legacy-token");
  equal(f.records.size,1);
});

test("an enabled but locked Vault never falls back and reports a bounded error", async () => {
  const f = fixture();
  f.lock();
  await rejects(f.resolver.resolve(account,evil),{message:"CREDENTIAL_VAULT_UNAVAILABLE"});
  equal(f.records.size,0);
});

test("a Vault read bound to another destination is rejected even after disable", async () => {
  const f = fixture();
  await f.resolver.resolve(account,legacy);
  const other = {...account,origin:"https://git.attacker.invalid"};
  await rejects(f.resolver.resolve(other,evil),{message:"CREDENTIAL_BINDING_CHANGED"});
  f.enable(false);
  await rejects(f.resolver.resolve(other,evil),{message:"CREDENTIAL_BINDING_CHANGED"});
});

test("a verified Vault record missing later is not recreated from backup", async () => {
  const f = fixture();
  await f.resolver.resolve(account,legacy);
  f.records.clear();
  await rejects(f.resolver.resolve(account,evil),{message:"CREDENTIAL_VAULT_MISSING"});
  equal(f.records.size,0);
  f.enable(false);
  await rejects(f.resolver.resolve(account,evil),{message:"CREDENTIAL_VAULT_MISSING"});
});
