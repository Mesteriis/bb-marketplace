// Run against the isolated BB described in docs/e2e-stand.md:
// node tests/adapters/app/stage-b-probe.mjs <stand-url> <playwright-tools-dir> <chromium>
// Requires acceptanceFixture, Terminals, the Stage B fixture workspace (sample.md,
// two revisions), and a Stage B target thread with the Stage B terminal fixture.
import { verifySelectArrow } from "../../ui/chrome/native-options.browser.mjs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const [url, tools, chrome] = process.argv.slice(2);
const {chromium} = createRequire(tools+"/")("playwright-core");
const browser = await chromium.launch({executablePath:chrome});
try {
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 page.setDefaultTimeout(11000);
 const actions=[];
 page.on("request",request => {
   const path=new URL(request.url()).pathname;
   if (/\/terminals\/.*(create|input|restart)|\/meetings\/.*join|\/remote[^/]*\/.*connect|\/messages\/send/.test(path)) actions.push(path);
 });
 const add = async () => {
   await page.getByRole("button",{name:"Добавить панель",exact:true}).click();
   return page.getByRole("dialog",{name:"Добавить панель"});
 };
 await page.goto(new URL("plugins/chertog/home",url).href);
 await page.getByRole("button",{name:/Тестовая панель/}).first().click();
 const frame=page.frameLocator('iframe[src*="live-frame"]').first();
 const boot=await frame.locator("#boot-id").textContent();
 await frame.locator("#input").fill("stage B fixture");
 await (await add()).getByRole("button",{name:"Terminals",exact:true}).click();
 const card=page.getByRole("region",{name:"Terminals",exact:true});
 await card.getByRole("link",{name:"Открыть раздел"}).click();
 await page.getByText(/No terminals open/).first().waitFor();
 await page.goBack();
 await card.getByRole("link",{name:"Открыть раздел"}).waitFor();
 console.log("PASS Terminals card selected in picker and opened installed provider, then returned");
 const divider=page.locator("[data-divider]").first();
 const before=await divider.boundingBox();
 await page.mouse.move(before.x+before.width/2,before.y+before.height/2);
 await page.mouse.down();
 await page.mouse.move(before.x+before.width/2+45,before.y+before.height/2,{steps:8});
 await page.mouse.up();
 await page.waitForFunction(x=> Math.abs(document.querySelector("[data-divider]").getBoundingClientRect().x-x)>1,before.x);
 console.log("PASS resized two-tile split using pointer: "+before.x+" -> "+(await divider.boundingBox()).x);
 for(const diff of [false,true]){
   const dialog=await add();
   const group=dialog.getByRole("region",{name:diff?"BB diff":"BB предпросмотр",exact:true});
   await group.getByRole("button",{name:"Выбрать среду"}).click();
   const env = group.getByLabel("Рабочая среда");
   await verifySelectArrow(env, "ArrowDown", 1);
   console.log("PASS environment ArrowDown selected fixture and kept focus");
   await group.getByRole("textbox",{name:"Путь к файлу"}).fill("sample.md");
   await group.getByRole("button",{name:"Найти",exact:true}).click();
   if(diff) {
     const from = group.getByLabel("Исходная ревизия");
     for(const [key,index] of [["ArrowDown",1],["ArrowDown",2],["ArrowUp",1],["ArrowDown",2]]) {
       await verifySelectArrow(from,key,index);
     }
     console.log("PASS revision ArrowDown/ArrowUp selected both revisions and kept focus");
     await group.getByRole("combobox",{name:"Конечная ревизия"}).selectOption({index:1});
   }
   try { await group.getByRole("button",{name:/sample.md/}).click(); } catch (e) { console.log("File picker: "+await group.innerText()); throw e; }
   await page.locator("[data-chertog-panel]").getByText(diff?"Old fixture":"New fixture",{exact:false}).first().waitFor();
   console.log("PASS "+(diff?"live two-revision diff":"live file preview")+" of sample.md");
 }
 const layout=()=>page.getByRole("button",{name:/^Раскладка:/});
 async function switchTo(name) {
   const wanted=page.getByRole("button",{name:"Раскладка: "+name,exact:true});
   for(let attempt=0;attempt<3;attempt++){
     if(await wanted.isVisible()) return;
     const menu=page.getByRole("dialog",{name:"Раскладки"});
     if(!await menu.isVisible()) await layout().click();
     try {
       await menu.getByRole("button",{name,exact:true}).click({timeout:3500});
       await wanted.waitFor({timeout:3500});
       return;
     } catch(error) {
       if(attempt===2) throw error;
     }
   }
 }
 const selected = [];
 const goals = [
   {name:"Команда агентов", action:"Выбрать файл", title:"sample.md", count:5},
   {name:"Администрирование", action:"Выбрать терминал", title:"BB терминал", count:4},
   {name:"Созвон", action:"Выбрать тред", title:"Stage B target", count:3},
 ];
 async function verifyTile(goal, afterReload) {
   const tile=page.locator('[data-group-id="'+goal.groupId+'"]');
   const tab=tile.getByRole("tab",{name:goal.title,exact:true});
   await tab.waitFor();
   const panelId=await tab.evaluate(el=>el.closest("[data-panel-id]").dataset.panelId);
   if(afterReload) assert.equal(panelId, goal.panelId);
   else {assert.notEqual(panelId,goal.chooserId);goal.panelId=panelId;}
   const host=page.locator('[data-live-host][data-panel-id="'+panelId+'"]');
   if(goal.action==="Выбрать файл") await host.getByText("New fixture",{exact:false}).first().waitFor();
   if(goal.action==="Выбрать терминал") {
     await host.getByRole("button",{name:"Открыть терминал"}).waitFor();
     await host.getByText("term_fixtureabc",{exact:false}).first().waitFor();
   }
   if(goal.action==="Выбрать тред") {
     if(!afterReload) await host.getByRole("button",{name:"Передать в другое окно"}).waitFor();
     await host.locator("[data-chertog-panel]").waitFor();
   }
   assert.equal(await tile.locator('[data-panel-id="'+goal.chooserId+'"]').count(),0);
   assert.equal(await page.locator("[data-group-id]").count(),goal.count);
   console.log("PASS "+goal.name+" "+(afterReload?"after reload":"target selected")+" group="+goal.groupId+" chooser="+goal.chooserId+" target="+panelId+" title="+goal.title);
 }
 for (const goal of goals){
   await layout().click();
   await page.getByRole("dialog",{name:"Раскладки"}).getByRole("button",{name:new RegExp(goal.name)}).click();
   await page.getByRole("button",{name:"Раскладка: "+goal.name,exact:true}).waitFor();
   const choose=page.getByRole("button",{name:goal.action,exact:true});
   goal.chooserId=await choose.evaluate(el=>el.closest("[data-live-host]").dataset.panelId);
   goal.groupId=await page.locator('[data-group-id] [data-panel-id="'+goal.chooserId+'"]').evaluate(el=>el.closest("[data-group-id]").dataset.groupId);
   await choose.click();
   const dialog=page.getByRole("dialog");
   assert.equal(await dialog.getByRole("region").count(),1);
   if(goal.action==="Выбрать файл"){
     await dialog.getByRole("button",{name:"Выбрать среду"}).click();
     await dialog.getByLabel("Рабочая среда").selectOption({label:"Stage B fixture"});
     await dialog.getByLabel("Путь к файлу").fill("sample.md");
     await dialog.getByRole("button",{name:"Найти",exact:true}).click();
     await dialog.getByRole("button",{name:/sample.md/}).click();
   } else if(goal.action==="Выбрать терминал"){
     await verifySelectArrow(dialog.getByLabel("Тред терминала"), "ArrowDown", 1);
     console.log("PASS terminal thread ArrowDown selected target and kept focus");
     await dialog.getByRole("button",{name:"Stage B terminal",exact:true}).click();
   } else {
     await dialog.getByRole("button",{name:/Stage B target/}).click();
   }
   await verifyTile(goal,false);
   selected.push(goal);
 }
 await switchTo("Основная");
 assert.equal(await frame.locator("#boot-id").textContent(),boot);
 assert.equal(await frame.locator("#input").inputValue(),"stage B fixture");
 console.log("PASS same fixture boot ID and draft after split, navigation and presets: "+boot);
 await page.reload();
 await card.getByRole("link",{name:"Открыть раздел"}).waitFor();
 for(const expected of ["New fixture","Old fixture"]) await page.locator("[data-chertog-panel]").getByText(expected,{exact:false}).first().waitFor();
 assert.equal(await page.locator("[data-group-id]").count(),4);
 const nextBoot=await frame.locator("#boot-id").textContent();
 assert.notEqual(nextBoot,boot);
 for (const goal of selected) {
   await switchTo(goal.name);
   await verifyTile(goal,true);
 }
 assert.deepEqual(actions,[]);
 console.log("PASS reload restored four tiles and both live renderers; frame reloaded with a fresh boot ID; no observed terminal create/input/restart, join, connect or send");
} finally {await browser.close()}
