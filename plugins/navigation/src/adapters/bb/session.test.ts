import {expect,it} from 'vitest';import {createSession} from './session';
const tick=()=>new Promise(r=>setTimeout(r,0));
it('recovers from a transient initial read error and enables editing again',async()=>{
 const session=createSession();let failed=true;let writes=0;
 session.connect(async()=>{if(failed)throw Error('Temporary read failure');return {kind:'empty'};},async(document,revision)=>{writes++;return {kind:'saved',document:{...document,revision:revision+1}}});
 await tick();expect(session.getSnapshot().error).toBe(true);failed=false;await session.refresh();await tick();
 expect(session.getSnapshot().error).toBe(false);session.edit([]);await tick();expect(writes).toBe(1);
});
it('initializes the current snapshot when catalogue changes during the first read',async()=>{
 const session=createSession();let resolve!:(value:unknown)=>void;let writes=0;
 session.connect(()=>new Promise(r=>resolve=r),async(document,revision)=>{writes++;return {kind:'saved',document:{...document,revision:revision+1}}});
 session.catalog([{id:'mail',label:'Почта',isVisible:true}]);resolve({kind:'empty'});await tick();
 expect(session.getSnapshot().error).toBe(false);expect(session.getSnapshot().document?.revision).toBe(0);session.edit([]);await tick();expect(writes).toBe(1);
});
