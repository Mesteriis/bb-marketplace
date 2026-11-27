import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/adapters/bb/host-contract.ts";
import { failureFor } from "./src/core/workspace.ts";
import { sshHostname } from "./src/adapters/bb/ssh-config.ts";
import { walkProjects } from "./src/adapters/bb/project-walk.ts";
import { maxDepth } from "./src/core/catalog/project-scan.ts";
import { isAbsolute } from "node:path";
import { assertWorktree, originUrl, cloneHttps, cloneLocal, exchangeHttps, localGit, worktreeIdentity } from "./src/adapters/bb/local-git.ts";

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async trash({root,identity},{signal}) {
      try {
        if (process.platform !== "darwin") throw new Error("TRASH_UNAVAILABLE");
        if ([homedir(),process.cwd()].some(path => path === root || path.startsWith(root + sep)) || root === sep)
          throw new Error("PROTECTED_FOLDER");
        const trees = await localGit(root,{kind:"worktrees"},signal);
        if (trees.worktrees?.length !== 1 || resolve(trees.worktrees[0].path) !== root)
          throw new Error("SHARED_WORKTREE");
        await assertWorktree(root,identity,signal,true);
        await promisify(execFile)("/usr/bin/trash",[root],{signal});
        return {ok:true as const};
      } catch (error) { return failureFor(error,"TRASH_FAILED"); }
    },
    async validate({root}, {signal}) {
      try { return {ok: true as const, ...await worktreeIdentity(root, signal, true)}; }
      catch (error) { return failureFor(error, "INVALID_WORKTREE"); }
    },
    async git({root, identity, action}, {signal}) {
      try {
        await assertWorktree(root,identity,signal,action.kind === "worktrees");
        return {ok: true as const, value: await localGit(root, action, signal)};
      }
      catch (error) { return failureFor(error, "GIT_REJECTED"); }
    },
    async cloneHttps({clone, username, destination}, {signal}) {
      try {
        const root = await cloneHttps(clone,username,destination,signal);
        return {ok:true as const,...await worktreeIdentity(root,signal)};
      }
      catch (error) { return failureFor(error,"GIT_REJECTED"); }
    },
    async exchangeHttps({clone, username, root, identity, action}, {signal}) {
      try {
        await assertWorktree(root,identity,signal);
        return {ok:true as const, value:await exchangeHttps(root, clone, username, action, signal)};
      }
      catch (error) { return failureFor(error,"GIT_REJECTED"); }
    },
    async originUrl({root, identity}, {signal}) {
      try {
        await assertWorktree(root,identity,signal);
        return {ok:true as const, url:await originUrl(root,signal)};
      }
      catch (error) { return failureFor(error,"NO_ORIGIN"); }
    },
    async scanProjects({root, exclude}) {
      try {
        if (!isAbsolute(root)) throw new Error("INVALID_PATH");
        const result = await walkProjects(root,{exclude,maxDepth});
        return {ok:true as const, verdicts:result.verdicts.slice(0,20_000), truncated:result.truncated || result.verdicts.length > 20_000};
      }
      catch (error) { return failureFor(error,"INVALID_PATH"); }
    },
    async sshHostname({alias}) {
      try { return {ok:true as const, hostname:await sshHostname(alias)}; }
      catch (error) { return failureFor(error,"SSH_CONFIG_UNAVAILABLE"); }
    },
    async cloneLocal({source, destination}, {signal}) {
      try {
        const root = await cloneLocal(source,destination,signal);
        return {ok:true as const,...await worktreeIdentity(root,signal)};
      }
      catch (error) { return failureFor(error, "GIT_REJECTED"); }
    },
  },
});
