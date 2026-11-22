import {DatabaseSync} from "node:sqlite";
const d=new DatabaseSync(process.argv[2]);
const now=Date.now();
const ins=d.prepare("insert or ignore into threads (id,project_id,provider_id,title,status,parent_thread_id,latest_attention_at,created_at,updated_at,status_changed_at) values (?,?,?,?,?,?,?,?,?,?)");
const rows=[["thr_main","Основной тред",null],["thr_sub1","Субтред один","thr_main"],["thr_sub2","Субтред два","thr_main"],["thr_other","Другой тред",null],["thr_fresh","Свежий тред",null]];
rows.forEach(([id,title,parent],i)=>ins.run(id,"proj_personal","claude-code",title,"idle",parent,now-i*1000,now-i*1000,now-i*1000,now));
console.log("seeded",d.prepare("select id,title,parent_thread_id from threads").all().length);
