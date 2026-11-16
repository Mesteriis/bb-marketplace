import {expect,test} from 'vitest';
import {sidebarPresentation, runningThreads} from '../src/core/presentation';
const projects=[{id:'p',name:'Project',path:'/Projects/Personal/Project',isPersonal:false},{id:'o',name:'Outside',path:'/Projects-extra/Other',isPersonal:false},{id:'loose',name:'Personal',path:null,isPersonal:true}];
const thread=(id:string,projectId:string,status='idle')=>({id,projectId,status,isHidden:false,isArchived:false,isPinned:false,title:id,titleFallback:null,parentThreadId:null,latestAttentionAt:100});
test('explicit root is omitted while siblings outside it are excluded',()=>{
 const view=sidebarPresentation(projects,[thread('one','p'),thread('outside','o')],{projects:[],threads:[]},false,'/Projects/');
 expect(view.tree.roots.map(n=>n.label)).toEqual(['Personal']);
 expect(view.tree.roots[0]?.key).toBe('/Personal');
 expect(view.tree.unrooted).toEqual([]);
});
test('projectless chats have their own section and never enter project pins',()=>{
 const view=sidebarPresentation(projects,[{...thread('loose-chat','loose'),isPinned:true}],{projects:[],threads:[]},false,'/Projects');
 expect(view.loose.map(t=>t.id)).toEqual(['loose-chat']);
 expect(view.tree.pinned).toEqual([]);
});
test('hidden categories expose only working threads; hidden idle chats stay hidden',()=>{
 const view=sidebarPresentation(projects,[thread('work','p','active'),thread('idle','p'),thread('hidden-worker','p','starting')],{projects:['p'],threads:['hidden-worker']},false,'/Projects');
 expect(view.running.map(t=>t.id)).toEqual(['work','hidden-worker']);
 expect(view.tree.roots).toEqual([]);
});
test('only running descendants escape collapsed ancestors, no idle parent rows',()=>{
 const parent={thread:thread('idle-parent','p'),children:[{thread:thread('busy-child','p','stopping'),children:[]}]};
 expect(runningThreads([parent]).map(t=>t.id)).toEqual(['busy-child']);
});

test('hiding the last worktree thread removes the empty worktree and its folder',()=>{
 const worktrees=[{id:'w',name:'feature',path:'/Projects/worktrees/feature',isPersonal:false}];
 const view=sidebarPresentation(worktrees,[thread('worktree-thread','w')],{projects:[],threads:['worktree-thread']},false,'/Projects');
 expect(view.tree.roots).toEqual([]);
 const shown=sidebarPresentation(worktrees,[thread('worktree-thread','w')],{projects:[],threads:['worktree-thread']},true,'/Projects');
 expect(shown.tree.roots[0]?.label).toBe('worktrees');
});
test('a hidden running worktree thread escapes without restoring the empty worktree',()=>{
 const view=sidebarPresentation([{id:'w',name:'feature',path:'/Projects/worktrees/feature',isPersonal:false}],[thread('running-worktree','w','active')],{projects:[],threads:['running-worktree']},false,'/Projects');
 expect(view.tree.roots).toEqual([]);
 expect(view.running.map(t=>t.id)).toEqual(['running-worktree']);
});

test('hiding a project hides its separately registered nested worktree projects',()=>{
 const nested=[{id:'base',name:'veda',path:'/Projects/veda',isPersonal:false},{id:'wt',name:'feature',path:'/Projects/veda/.claude/worktrees/feature',isPersonal:false},{id:'other',name:'veda-other',path:'/Projects/veda-other',isPersonal:false}];
 const hidden={projects:['base'],threads:[]};
 const view=sidebarPresentation(nested,[thread('wt-idle','wt'),thread('other-idle','other')],hidden,false,'/Projects');
 expect(view.tree.roots.map(n=>n.project?.id)).toEqual(['other']);
 const busy=sidebarPresentation(nested,[thread('wt-busy','wt','active')],hidden,false,'/Projects');
 expect(busy.tree.roots.map(n=>n.label)).not.toContain('veda');
 expect(busy.running.map(t=>t.id)).toEqual(['wt-busy']);
 const revealed=sidebarPresentation(nested,[thread('wt-idle','wt')],hidden,true,'/Projects');
 expect(revealed.tree.roots.some(n=>n.project?.id==='base')).toBe(true);
});
