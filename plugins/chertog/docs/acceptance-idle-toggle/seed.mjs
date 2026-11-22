// seed.mjs DB [N]: N top-level threads, each with 2 subthreads (default 12 -> 36 threads), like docs/acceptance-open/seed.mjs plus a few named ones.
import {DatabaseSync} from "node:sqlite";
const d=new DatabaseSync(process.argv[2]);
const n=Number(process.argv[3]??12);
const now=Date.now();
const ins=d.prepare("insert or ignore into threads (id,project_id,provider_id,title,status,parent_thread_id,latest_attention_at,created_at,updated_at,status_changed_at) values (?,?,?,?,?,?,?,?,?,?)");
const rows=[["thr_main","Основной тред",null],["thr_sub1","Субтред один","thr_main"],["thr_sub2","Субтред два","thr_main"],["thr_other","Другой тред",null],["thr_fresh","Свежий тред",null]];
for(let i=0;i<n;i++){const id="thr_p"+i;rows.push([id,"Тред номер "+(i+1),null],[id+"a","Подтред "+(i+1)+".1",id],[id+"b","Подтред "+(i+1)+".2",id]);}
rows.forEach(([id,title,parent],i)=>ins.run(id,"proj_personal","claude-code",title,"idle",parent,now-i*1000,now-i*1000,now-i*1000,now));
console.log("seeded",d.prepare("select count(*) c from threads").get().c);
