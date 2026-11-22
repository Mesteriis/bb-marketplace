// churn.mjs STAND SECONDS (STAND_CLI = a script that runs the stand's bb CLI as `cli.sh STAND args...`): every 1-2 s change the status of 3 random threads (idle/active/error) in the stand DB,
// then ask BB (bb thread unread/read on one of them) so the server publishes thread updates to connected windows.
import {DatabaseSync} from "node:sqlite";
import {execFile} from "node:child_process";
import fs from "node:fs";
const [stand, secs="60"] = process.argv.slice(2);
const d=new DatabaseSync(stand+"/data/bb.db");
d.exec("pragma busy_timeout=5000");
const ids=d.prepare("select id from threads").all().map(r=>r.id);
const upd=d.prepare("update threads set status=?, updated_at=?, status_changed_at=? where id=?");
const st=["idle","active","error"];
const cli=(...a)=>new Promise(r=>execFile(process.env.STAND_CLI,[stand,...a],()=>r()));
const end=Date.now()+Number(secs)*1000; let ticks=0, flip=false;
while(Date.now()<end){
  const now=Date.now(); const picked=[];
  for(let k=0;k<3;k++){const id=ids[Math.floor(Math.random()*ids.length)];picked.push(id);upd.run(st[Math.floor(Math.random()*3)],now,now,id);}
  if (process.env.NOTIFY !== "0") { flip=!flip; await cli("thread", flip?"unread":"read", picked[0]); }
  ticks++;
  await new Promise(r=>setTimeout(r,1000+Math.random()*1000));
}
console.log("churn ticks",ticks);
