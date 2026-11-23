import { deepEqual, rejects, equal } from "node:assert/strict";
import { test } from "node:test";
import { detectProvider } from "../src/core/connection.ts";
import { checkConnection } from "../src/adapters/bb/connection.ts";

test("recognizes hosted providers and extracts the Azure organization", () => {
  deepEqual(detectProvider("https://github.com/example/api.git"),{kind:"github",origin:"https://github.com",organization:""});
  deepEqual(detectProvider("git@github.com:example/api.git"),{kind:"github",origin:"https://github.com",organization:""});
  deepEqual(detectProvider("https://dev.azure.com/Example/Project/_git/repo"),{kind:"azure",origin:"https://dev.azure.com",organization:"Example"});
  deepEqual(detectProvider("git@ssh.dev.azure.com:v3/Example/Project/repo"),{kind:"azure",origin:"https://dev.azure.com",organization:"Example"});
});

test("does not guess a self-hosted provider or accept embedded credentials", () => {
  deepEqual(detectProvider("https://git.example.com/team/repo"),{kind:null,origin:"https://git.example.com",organization:""});
  equal(detectProvider("https://github.com.other.example/owner/repo")?.kind,null);
  equal(detectProvider("https://alice:secret@github.com/team/repo"),null);
  equal(detectProvider("https://github.com/team/repo?token=secret"),null);
  equal(detectProvider("http://github.com/team/repo"),null);
});

const candidate = {kind:"github" as const,origin:"https://github.com",organization:"",label:"Example",username:"",token:"fixture-secret"};

test("checks GitHub identity and repository access without returning a credential", async () => {
  const destinations:string[] = [];
  const send:typeof fetch = async (input,options) => {
    destinations.push(String(input));
    equal(options?.method,"GET");
    equal(options?.redirect,"error");
    equal(new Headers(options?.headers).get("authorization"),"Bearer fixture-secret");
    return Response.json(String(input).endsWith("/user") ? {login:"example-user"} :
      [{id:1,name:"api",full_name:"example/api",clone_url:"https://github.com/example/api.git"}]);
  };
  const result = await checkConnection(candidate,"new",send);
  deepEqual(destinations,["https://api.github.com/user","https://api.github.com/user/repos?per_page=40&page=1"]);
  deepEqual(result.repositories,["example/api"]);
  equal(result.account.username,"example-user");
  equal(JSON.stringify(result).includes("fixture-secret"),false);
});

test("marks a rejected credential and requires explicit Azure organization", async () => {
  const send:typeof fetch = async () => new Response(null,{status:401});
  await rejects(checkConnection(candidate,"new",send),/PROVIDER_DENIED/);
  await rejects(checkConnection({...candidate,kind:"azure",origin:"https://dev.azure.com",username:"alice"},"new",send),/INVALID_INPUT/);
  await rejects(checkConnection({...candidate,origin:"https://dev.azure.com"},"new",send),/INVALID_INPUT/);
});

test("checks Azure repository access in the selected organization with a read-only request", async () => {
  const send:typeof fetch = async (url,options) => {
    equal(String(url),"https://dev.azure.com/Example/_apis/git/repositories?api-version=7.1");
    equal(options?.method,"GET");
    equal(new Headers(options?.headers).get("authorization"),"Basic OmZpeHR1cmUtc2VjcmV0");
    return Response.json({value:[{id:"1",name:"api",project:{name:"Platform"},remoteUrl:"https://dev.azure.com/Example/Platform/_git/api"}]});
  };
  const result = await checkConnection({...candidate,kind:"azure",origin:"https://dev.azure.com",organization:"Example",username:"example-user"},"new",send);
  deepEqual(result.repositories,["Platform/api"]);
});
