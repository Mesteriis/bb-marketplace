import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/adapters/bb/host-contract.ts";
import { failureFor } from "./src/core/workspace.ts";
import { sshHostname } from "./src/adapters/bb/ssh-config.ts";
import { commitDetails, commitPatch, historyPage, historyRevision, workingPatch } from "./src/adapters/bb/history-git.ts";
import { probeForge } from "./src/adapters/bb/forge-probe.ts";
import { createRunGit, diff as reviewDiff, GitError } from "./src/adapters/bb/review-git.ts";
import { readReviewFile, writeReviewFile } from "./src/adapters/bb/review-files.ts";

const reviewGit = createRunGit();
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
    async scanProjects({root, exclude}, {signal}) {
      try {
        const folder = root === "~" || root.startsWith("~/") ? homedir() + root.slice(1) : root;
        if (!isAbsolute(folder)) throw new Error("INVALID_PATH");
        const result = await walkProjects(folder,{exclude,maxDepth},undefined,signal);
        return {ok:true as const, verdicts:result.verdicts.slice(0,20_000), truncated:result.truncated || result.verdicts.length > 20_000};
      }
      catch (error) { return failureFor(error,"INVALID_PATH"); }
    },
    async probeForge({origin}) {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search) return {kind:null};
      return {kind:await probeForge(url.origin)};
    },
    async historyPage({root, identity, offset, limit}, {signal}) {
      try { await assertWorktree(root,identity,signal); return {ok:true as const, value:await historyPage(root,offset,limit,signal)}; }
      catch (error) { return failureFor(error,"GIT_REJECTED"); }
    },
    async historyRevision({root, identity}, {signal}) {
      try { await assertWorktree(root,identity,signal); return {ok:true as const, revision:await historyRevision(root,signal)}; }
      catch (error) { return failureFor(error,"GIT_REJECTED"); }
    },
    async historyCommit({root, identity, hash}, {signal}) {
      try { await assertWorktree(root,identity,signal); return {ok:true as const, value:await commitDetails(root,hash,signal)}; }
      catch (error) { return failureFor(error,"GIT_REJECTED"); }
    },
    async reviewDiff({root, identity, target, ignoreWhitespace}, {signal}) {
      try {
        await assertWorktree(root,identity,signal);
        return {ok:true as const, value:await reviewDiff(reviewGit, root, target, ignoreWhitespace)};
      } catch (error) {
        // diff-review's git reports in sentences; the plugin answers in codes.
        const unknown = error instanceof GitError && /^Unknown revision|no common ancestor/.test(error.message);
        return failureFor(unknown ? new Error("UNKNOWN_REVISION") : error, error instanceof GitError && error.message.includes("too large") ? "GIT_OUTPUT_LIMIT" : "GIT_REJECTED");
      }
    },
    async reviewFile({root, identity, path}, {signal}) {
      try { await assertWorktree(root,identity,signal); return {ok:true as const, ...await readReviewFile(root,path)}; }
      catch (error) { return failureFor(error,"INVALID_PATH"); }
    },
    async reviewWrite({root, identity, path, expected, text}, {signal}) {
      try { await assertWorktree(root,identity,signal); return {ok:true as const, ...await writeReviewFile(root,path,expected,text)}; }
      catch (error) { return failureFor(error,"OUTCOME_UNKNOWN"); }
    },
    async historyPatch({root, identity, hash, path}, {signal}) {
      try {
        await assertWorktree(root,identity,signal);
        return {ok:true as const, value:hash === null ? await workingPatch(root,path,signal) : await commitPatch(root,hash,path,signal)};
      }
      catch (error) { return failureFor(error,"GIT_REJECTED"); }
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
