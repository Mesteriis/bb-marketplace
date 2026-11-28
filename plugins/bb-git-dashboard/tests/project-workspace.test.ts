import { deepEqual, equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import { projectForCopy, projectTree, sidebarFolders, nestedFolders } from "../src/core/project-workspace.ts";
import { repositoryFeatures } from "../src/adapters/bb/repository-features.ts";
import type { Account, Repo } from "../src/core/providers.ts";
import type { Http } from "../src/adapters/bb/provider-http.ts";

const projects = [{id:"platform",name:"Platform"}, {id:"lab",name:"Lab"}];
const main = {id:"primary", root:"/project/api", hostId:"mac", identity:"primary", repository:"shared", projectId:"platform"};
const linked = {id:"linked", root:"/other/retry", hostId:"mac", identity:"linked", repository:"shared"};
const differentHost = {...linked, id:"other-host", hostId:"linux"};

test("project assignment uses the exact path and host and handles ambiguity", () => {
  const location = {path:linked.root,hostId:"mac",projectId:"platform"};
  equal(projectForCopy(linked,projects,[location]),"platform");
  equal(projectForCopy(differentHost,projects,[location]),undefined);
  equal(projectForCopy({...linked,root:linked.root+"/child"},projects,[location]),undefined);
  equal(projectForCopy(linked,projects,[location,{...location,projectId:"lab"}]),undefined);
  equal(projectForCopy({...linked,projectId:"lab"},projects,[location]),"lab");
});

test("two worktrees of a repository group on their host inside the same project", () => {
  const groups = projectTree(projects,[main,{...linked,projectId:"platform"},differentHost,{...linked,id:"lab-api",projectId:"lab"}]);
  deepEqual(groups.map(group => [group.name,group.repositories.map(repo => repo.copies.map(copy => copy.id))]),
    [["Platform",[["primary","linked"]]],["Lab",[["lab-api"]]],["Unassigned",[["other-host"]]]]);
});

const account: Account = {id:"github",kind:"github",label:"GitHub",origin:"https://github.com",organization:"",username:"developer"};
const repo: Repo = {id:"1",accountId:"github",path:"platform/api",project:"platform",name:"api",
  clone:"https://github.com/platform/api.git",branch:"main",canPush:null};

test("repository issues use the selected repository and exclude pull requests", async () => {
  const paths: string[] = [];
  const http: Http = async path => {
    paths.push(path);
    return {headers:new Headers(),payload:[{number:5,title:"Fix retry",state:"open"},
      {number:6,title:"PR",pull_request:{},state:"open"}]};
  };
  const result = await repositoryFeatures(account,repo,"issues",http);
  deepEqual(paths,["/repos/platform/api/issues?state=all&per_page=30"]);
  deepEqual(result.items.map(row => [row.name,row.status]),[["#5 Fix retry","open"]]);
});

test("secrets expose names only and failures are distinct from empty lists", async () => {
  const http: Http = async path => ({headers:new Headers(),payload:path.includes("/secrets") ?
    {secrets:[{name:"TOKEN",value:"SENTINEL"}]} : {variables:[{name:"REGION",value:"us-east"}]}});
  const result = await repositoryFeatures(account,repo,"variables",http);
  deepEqual(result.items.map(row => [row.name,row.detail]),[["REGION","us-east"],["TOKEN",null]]);
  await rejects(repositoryFeatures(account,repo,"actions",async () => {throw new Error("PROVIDER_DENIED");}),/PROVIDER_DENIED/);
});

test("Azure pipelines are filtered by Git repository ID and Boards remain project-scoped", async () => {
  const azure = {...account,kind:"azure" as const,origin:"https://dev.azure.com",organization:"Example"};
  const paths: string[] = [];
  const http: Http = async path => {paths.push(path);return {headers:new Headers(),payload:{value:[]}};};
  await repositoryFeatures(azure,{...repo,project:"App Project"},"actions",http);
  deepEqual(paths,["/Example/App%20Project/_apis/build/builds?repositoryId=1&repositoryType=TfsGit&%24top=30&api-version=7.1"]);
  equal((await repositoryFeatures(azure,repo,"issues",http)).notice,"Azure Boards are scoped to the Azure DevOps project.");
  equal(paths.length,1);
});

test("sidebar filters by project or parent and keeps unrelated matching folder names separate", () => {
  const rows = projectTree([
    {id:"a",name:"Alpha",folder:{path:"/one/Work",hostId:"local"}},
    {id:"b",name:"Beta",folder:{path:"/two/Work",hostId:"local"}},
    {id:"c",name:"Gamma"},
  ],[]);
  deepEqual(sidebarFolders(rows," WORK ").map(folder => folder.rows.map(row => row.id)),[["a"],["b"]]);
  equal(sidebarFolders(rows,"alp")[0]?.label,"Work");
  // A project without a source has no folder; the interface names it in its own language.
  equal(sidebarFolders(rows,"gamma")[0]?.label,"");
  equal(sidebarFolders(rows,"absent").length,0);
});

test("nested folders keep projects at intermediate nodes and search alternate sources", () => {
  const rows = projectTree([
    {id:"a",name:"A",folder:{path:"/projects/team",hostId:"local"}},
    {id:"b",name:"B",folder:{path:"/projects/team/sub",hostId:"local"},
     sources:[{id:"s",hostId:"other",path:"/external/library",isDefault:false}]},
  ],[]);
  const [tree] = nestedFolders(rows,"");
  equal(tree.count,2);
  equal(tree.rows[0].id,"a");
  equal(tree.children[0].rows[0].id,"b");
  equal(nestedFolders(rows,"library")[0].rows[0].id,"b");
});

test("categories are named relative to the projects folder, with the full path kept for a tooltip", () => {
  const rows = projectTree([
    {id:"a",name:"A",folder:{path:"/home/owner/projects/Personal",hostId:"local"}},
    {id:"b",name:"B",folder:{path:"/home/owner/projects/Work",hostId:"local"}},
    {id:"c",name:"C",folder:{path:"/home/owner/projects/Work/clients",hostId:"local"}},
  ],[]);
  deepEqual(nestedFolders(rows,"").map(folder => [folder.label, folder.path, folder.children.map(child => child.label)]),
    [["Personal","/home/owner/projects/Personal",[]], ["Work","/home/owner/projects/Work",["clients"]]]);
  // Projects straight in the projects folder: the one category is that folder, by its name.
  const flat = projectTree([{id:"d",name:"D",folder:{path:"/home/owner/projects",hostId:"local"}},
    {id:"e",name:"E",folder:{path:"/home/owner/projects",hostId:"local"}}],[]);
  deepEqual(nestedFolders(flat,"").map(folder => [folder.label, folder.path]), [["projects","/home/owner/projects"]]);
});
