import test from "node:test";
import assert from "node:assert/strict";
import type { Account } from "../src/core/providers.ts";
import { provider } from "../src/adapters/bb/provider.ts";

const implementation = () => import("../src/adapters/bb/provider.ts");
const fixture = [
  { kind:"github", origin:"https://api.github.com", project:"", url:"/user/repos", body:[{id:5,name:"demo",full_name:"team/demo",clone_url:"https://github.com/team/demo.git",default_branch:"main"}] },
  { kind:"azure", origin:"https://dev.azure.com", project:"org", url:"/org/_apis/git/repositories", body:{value:[{id:"repo-id",name:"demo",project:{name:"team"},remoteUrl:"https://dev.azure.com/org/team/_git/demo",defaultBranch:"refs/heads/main"}]} },
  { kind:"gitea", origin:"https://git.example.invalid", project:"", url:"/api/v1/user/repos", body:[{id:5,name:"demo",full_name:"team/demo",clone_url:"https://git.example.invalid/team/demo.git",default_branch:"main"}] },
] as const;

for (const setup of fixture) {
  test(setup.kind + " normalizes repository metadata and addresses only the configured instance", async () => {
    const { provider } = await implementation();
    const account: Account = {kind:setup.kind, origin:setup.origin, organization:setup.project, id:"a", label:"A", username:"alice"};
    const api = provider(account,"sample-secret",async (target, options) => {
      const url = new URL(String(target));
      assert.equal(url.origin, setup.origin);
      assert.equal(url.pathname, setup.url);
      assert.notEqual(new Headers(options?.headers).get("authorization"), null);
      assert.equal(options?.redirect, "error");
      return Response.json(setup.body);
    });
    const catalog = await api.repositories(1);
    assert.equal(catalog.items.length, 1);
    assert.equal(catalog.items[0].accountId,"a");
    assert.equal(catalog.items[0].project,"team");
    assert.equal(catalog.items[0].branch,"main");
    assert.doesNotMatch(JSON.stringify(catalog),/sample-secret/);
  });
}

test("a denied Gitea account never reuses the first account credential", async () => {
  const {provider} = await implementation();
  const base: Account = {kind:"gitea",origin:"https://git.example.invalid",organization:"",id:"a",label:"A",username:"alice"};
  const actors: string[] = [];
  const mock: typeof fetch = async (_, options) => {
    const value = new Headers(options?.headers).get("authorization")!;
    actors.push(value);
    return value.endsWith("A") ? Response.json([]) : Response.json({message:"secretB"}, {status:403});
  };
  const [first, second] = await Promise.allSettled([
    provider(base,"secretA",mock).repositories(1),
    provider({...base,id:"b",username:"bob"},"secretB",mock).repositories(1),
  ]);
  assert.equal(first.status,"fulfilled");
  assert.equal(second.status,"rejected");
  if (second.status === "rejected") assert.equal(second.reason.message,"PROVIDER_DENIED");
  assert.deepEqual(actors.sort(),["token secretA","token secretB"]);
});

for (const kind of ["github","gitea"] as const) {
  const expected = "2".repeat(40);
  test(kind + " binds merge to the confirmed head at the provider", async () => {
    const {provider} = await implementation();
    const account: Account = {kind,origin:kind === "github" ? "https://api.github.com" : "https://git.example.invalid",organization:"",id:"a",label:"A",username:"alice"};
    const repository = {id:"5",accountId:"a",path:"team/demo",clone:"https://git.example.invalid/team/demo.git",project:"team",name:"demo",branch:"main",canPush:true};
    let merged = false;
    let writes = 0;
    const api = provider(account,"canary-token",async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/merge")) {
        writes++;
        assert.deepEqual(JSON.parse(String(options?.body)), kind === "github" ? {sha:expected} : {Do:"merge",head_commit_id:expected});
        assert.equal(options?.method,kind === "github" ? "PUT" : "POST");
        merged = true;
        return kind === "github" ? Response.json({merged:true}) : new Response(null,{status:204});
      }
      return Response.json({number:9,title:"PR",state:"open",merged,head:{ref:"feature",sha:expected,repo:{full_name:"team/demo"}},base:{ref:"main",sha:"3".repeat(40),repo:{full_name:"team/demo"}}});
    });
    await assert.rejects(api.mutate(repository,{kind:"merge",number:9,expected:"1".repeat(40)}),/STALE_HEAD/);
    assert.equal(writes,0);
    assert.deepEqual(await api.mutate(repository,{kind:"merge",number:9,expected}),{number:9,outcome:"completed"});
    assert.equal(writes,1);
  });
}

test("does not repeat an external write after a lost response or expose its exception", async () => {
  const {provider} = await implementation();
  const account: Account = {kind:"gitea",origin:"https://git.example.invalid",organization:"",id:"a",label:"A",username:"alice"};
  let writes = 0;
  const api = provider(account,"canary-token",async (_,options) => {
    if (options?.method === "POST") {writes++;throw new Error("network dropped canary-token");}
    return Response.json({commit:{id:"1".repeat(40)}});
  });
  await assert.rejects(api.mutate({id:"5",accountId:"a",path:"team/demo",clone:"https://git.example.invalid/team/demo.git",
    project:"team",name:"demo",branch:"main",canPush:true},
    {kind:"create",head:"feature",base:"main",expected:"1".repeat(40),title:"Test",body:""}),{message:"OUTCOME_UNKNOWN"});
  assert.equal(writes,1);
});

const lookups = [
  {kind:"github", origin:"https://api.github.com", organization:"", path:"Mesteriis/makosh-git-sandbox", url:"/repos/Mesteriis/makosh-git-sandbox",
    body:{id:7,name:"makosh-git-sandbox",full_name:"Mesteriis/makosh-git-sandbox",clone_url:"https://github.com/Mesteriis/makosh-git-sandbox.git",default_branch:"main",permissions:{push:true}},
    expected:{id:"7",path:"Mesteriis/makosh-git-sandbox",project:"Mesteriis",branch:"main",canPush:true}},
  {kind:"gitea", origin:"https://git.example.invalid", organization:"", path:"team/demo", url:"/api/v1/repos/team/demo",
    body:{id:5,name:"demo",full_name:"team/demo",clone_url:"https://git.example.invalid/team/demo.git",default_branch:"dev"},
    expected:{id:"5",path:"team/demo",project:"team",branch:"dev",canPush:null}},
  {kind:"azure", origin:"https://dev.azure.com", organization:"org", path:"Team Project/demo", url:"/org/Team%20Project/_apis/git/repositories/demo",
    body:{id:"repo-id",name:"demo",project:{name:"Team Project"},remoteUrl:"https://dev.azure.com/org/Team%20Project/_git/demo",defaultBranch:"refs/heads/main"},
    expected:{id:"repo-id",path:"Team Project/demo",project:"Team Project",branch:"main",canPush:null}},
] as const;

for (const setup of lookups) {
  test(setup.kind + " looks up one repository by its path", async () => {
    const account: Account = {kind:setup.kind,origin:setup.origin,organization:setup.organization,id:"a",label:"A",username:"alice"};
    const api = provider(account,"sample-secret",async target => {
      assert.equal(new URL(String(target)).pathname,setup.url);
      return Response.json(setup.body);
    });
    const found = await api.repository(setup.path);
    assert.deepEqual({id:found.id,path:found.path,project:found.project,branch:found.branch,canPush:found.canPush},setup.expected);
    assert.equal(found.accountId,"a");
  });
}

test("a repository path with dot segments is refused before any request", async () => {
  const account: Account = {kind:"github",origin:"https://api.github.com",organization:"",id:"a",label:"A",username:"alice"};
  const api = provider(account,"t",async () => { throw new Error("must not be called"); });
  await assert.rejects(api.repository("../x"),{message:"INVALID_INPUT"});
});
