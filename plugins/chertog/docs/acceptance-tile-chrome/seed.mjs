// Seed unread threads into a stand's bb.db without starting an agent.
//   node seed.mjs <bb.db>                     the seven threads of docs/acceptance-open plus «Передача окна» and «Соседний тред»
//   node seed.mjs <bb.db> probe <suffix>      «Тред альфа|бета|гамма <suffix>» for probe.mjs
//   node seed.mjs <bb.db> narrow <suffix>     «Узкий 0..9 <suffix>» for narrow.mjs
// A thread that has been opened is read and leaves the sidebar's «Сейчас» list, so every run needs a new suffix.
import { DatabaseSync } from "node:sqlite";
const [path, mode, suffix] = process.argv.slice(2);
const d = new DatabaseSync(path);
const now = Date.now();
const ins = d.prepare("insert or ignore into threads (id,project_id,provider_id,title,status,parent_thread_id,latest_attention_at,created_at,updated_at,status_changed_at) values (?,?,?,?,?,?,?,?,?,?)");
const add = (id, title, parent, at) => ins.run(id, "proj_personal", "claude-code", title, "idle", parent, at, now, now, now);
if (mode === "probe") ["альфа", "бета", "гамма"].forEach((t, i) => add("thr_" + suffix + i, "Тред " + t + " " + suffix, null, now + i * 1000));
else if (mode === "narrow") for (let i = 0; i < 10; i++) add("thr_n" + suffix + i, "Узкий " + i + " " + suffix, null, now + i * 1000);
else [["thr_main", "Основной тред", null], ["thr_sub1", "Субтред один", "thr_main"], ["thr_sub2", "Субтред два", "thr_main"], ["thr_other", "Другой тред", null], ["thr_fresh", "Свежий тред", null], ["thr_handoff", "Передача окна", null], ["thr_neighbor", "Соседний тред", null]].forEach(([id, title, parent], i) => add(id, title, parent, now - i * 1000));
console.log("threads:", d.prepare("select count(*) as n from threads").get().n);
