import test from "node:test";
import assert from "node:assert/strict";
import type { Http } from "../src/adapters/bb/provider-http.ts";
import type { Account, Repo } from "../src/core/providers.ts";

const implementation = () => import("../src/adapters/bb/azure-provider.ts");
const head = "1111111111111111111111111111111111111111";
const base = "2222222222222222222222222222222222222222";
const account: Account = {kind:"azure", id:"work", label:"Work", origin:"https://dev.azure.com", organization:"example-org", username:"fixture"};
const repo: Repo = {id:"repo-guid", accountId:account.id, project:"Project", name:"repo", path:"Project/repo", clone:"https://dev.azure.com/example-org/Project/_git/repo", branch:"main", canPush:null};
const apiPull = {pullRequestId:8, title:"Repairs", description:"Description", status:"active", sourceRefName:"refs/heads/topic", targetRefName:"refs/heads/main", lastMergeSourceCommit:{commitId:head}, lastMergeTargetCommit:{commitId:base}};
const reply = (payload: unknown) => ({payload, headers:new Headers()});

test("completes only a matching revision and puts that revision in the Azure completion request", async () => {
  const {azureProvider} = await implementation();
  const seen: Array<{path:string; options:Parameters<Http>[1]}> = [];
  const service = azureProvider(account, async (path, options) => {
    seen.push({path,options});
    if (path.includes("/refs?")) return reply({value:[{name:"refs/heads/topic", objectId:head}]});
    return reply(options?.method === "PATCH" ? {...apiPull,status:"completed"} : apiPull);
  });
  await assert.rejects(service.mutate(repo,{kind:"merge",number:8,expected:base}), /STALE_HEAD/);
  assert.equal(seen.filter(row => row.options?.method === "PATCH").length,0);
  assert.deepEqual(await service.mutate(repo,{kind:"merge",number:8,expected:head}),{number:8,outcome:"completed"});
  const write = seen.find(row => row.options?.method === "PATCH")!;
  assert.match(write.path,/\/example-org\/Project\/_apis\/git\/repositories\/repo-guid\/pullRequests\/8\?api-version=7\.1$/);
  assert.deepEqual(write.options?.body,{status:"completed",lastMergeSourceCommit:{commitId:head}});
});

test("keeps Azure PR metadata and comments when a restricted credential cannot read statuses", async () => {
  const {azureProvider} = await implementation();
  const service = azureProvider(account, async path => {
    if (path.includes("/statuses?")) throw new Error("PROVIDER_DENIED");
    if (path.includes("/threads?")) return reply({value:[{comments:[{author:{displayName:"Reviewer"}, content:"Review note"}]}]});
    if (path.includes("/iterations?")) return reply({value:[{id:1},{id:2}]});
    if (path.includes("/iterations/2/changes?")) return reply({changeEntries:[{item:{path:"/src/main.ts"}, changeType:"edit"}]});
    return reply(apiPull);
  });
  const result = await service.details(repo,8);
  assert.equal(result.pull.head.sha,head);
  assert.equal(result.pull.base.sha,base);
  assert.equal(result.diff,null);
  assert.deepEqual(result.changes,["edit /src/main.ts"]);
  assert.deepEqual(result.comments,[{author:"Reviewer",body:"Review note"}]);
  assert.deepEqual(result.checks,[]);
  assert(result.issues.includes("PR statuses: PROVIDER_DENIED"));
});

test("uses exact ref identity rather than another branch with the same prefix when creating a PR", async () => {
  const {azureProvider} = await implementation();
  const service = azureProvider(account, async (path, options) => {
    const url = new URL(path,account.origin);
    if (url.pathname.endsWith("/refs")) {
      assert.equal(url.searchParams.get("filter"),"heads/topic");
      return reply({value:[
        {name:"refs/heads/topic/other",objectId:base},
        {name:"refs/heads/topic",objectId:head},
      ]});
    }
    assert.equal(options?.method,"POST");
    assert.deepEqual(options.body,{
      sourceRefName:"refs/heads/topic", targetRefName:"refs/heads/main", title:"Fix", description:"Summary",
    });
    return reply({pullRequestId:42});
  });
  await assert.rejects(service.mutate(repo,{kind:"create",head:"topic",base:"main",expected:base,title:"Fix",body:"Summary"}),/STALE_HEAD/);
  assert.deepEqual(await service.mutate(repo,{kind:"create",head:"topic",base:"main",expected:head,title:"Fix",body:"Summary"}),{number:42,outcome:"completed"});
});

test("does not report completion while Azure still reports the pull request active", async () => {
  const {azureProvider} = await implementation();
  const service = azureProvider(account, async path => path.includes("/refs?")
    ? reply({value:[{name:"refs/heads/topic",objectId:head}]})
    : reply(apiPull));
  assert.deepEqual(await service.mutate(repo,{kind:"merge",number:8,expected:head}),{number:8,outcome:"accepted"});
});
