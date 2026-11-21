// @vitest-environment jsdom
import {afterEach,expect,test,vi} from 'vitest';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {PlanTrack} from '../src/ui/plan-track';
import {PlanStrip,ThreadProgress} from '../src/ui/thread-progress';
import {aggregateProgress,planProgress,progressMarks,compactProgressMarks,sidebarPlans,visiblePlans,type Plan} from '../src/core/progress';
import {migrationEntry,sameRecord} from '../src/core/planning/migration';
afterEach(cleanup);
const plan=(overrides:Partial<Plan>={}):Plan=>({id:'plan',title:'Проверить изменение',state:'running',updatedAt:1,stages:[{name:'Проверка',steps:[{title:'Подготовка',status:'done'},{title:'Тесты',status:'active'},{title:'Отчёт',status:'pending'}]}],...overrides});
test('plan completion is independent of thread completion and does not invent completed steps',()=>{
 expect(planProgress(plan({state:'done'}))).toMatchObject({done:1,total:3,percent:33});
 expect(planProgress(plan({stages:[]}))).toMatchObject({done:0,total:0,percent:0});
});
test('errors and questions precede recent plans; hidden plans do not leak into rows',()=>{
 const plans=[plan(),plan({id:'question',state:'needs_input'}),plan({id:'error',state:'error'}),plan({id:'hidden',hidden:'manual',state:'error'})];
 expect(visiblePlans(plans).map(p=>p.id)).toEqual(['error','question','plan']);
 expect(plans.map(p=>p.id)).toEqual(['plan','question','error','hidden']);
});
test('collapsed plan shows its progress; opening reveals stages without navigation',async()=>{
 const slot=render(<PlanStrip plan={plan()}/>);
 expect(slot.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('33');
 fireEvent.click(slot.getByText('Проверка → Тесты'));
 expect(await slot.findByText('Подготовка')).toBeTruthy();
 expect(slot.getByText('Не начат')).toBeTruthy();
});
test('filling changes only when real steps change, and preserves original effects',()=>{
 const slot=render(<PlanStrip plan={plan()}/>);
 expect(slot.container.querySelector('.mspp-wave')).toBeTruthy();
 expect(slot.container.querySelectorAll('.mspp-blink')).toHaveLength(4);
 slot.rerender(<PlanStrip plan={plan({stages:[{name:'Проверка',steps:[{title:'Подготовка',status:'done'},{title:'Тесты',status:'done'},{title:'Отчёт',status:'active'}]}]})}/>);
 expect(slot.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('67');
 slot.rerender(<PlanStrip plan={plan()} effects={false}/>);
 expect(slot.container.querySelector('.mspp-wave')).toBeNull();
 expect(slot.container.querySelector('.mspp-blink')).toBeNull();
});
test('a question or failure exposes its note without opening the plan',()=>{
 const slot=render(<PlanStrip plan={plan({state:'needs_input',note:'Уточнить критерии'})}/>);
 expect(slot.getByText('Уточнить критерии',{selector:'.progress-caption'})).toBeTruthy();
});
test('one disclosure keeps the status and additional plans reachable without another summary row',async()=>{
 const slot=render(<ThreadProgress plans={[plan(),plan({id:'second',title:'Второй план'})]} status={{label:'В работе',state:'running'}}/>);
 expect(slot.getByLabelText('Ещё планов: 1').textContent).toBe('+1');
 expect(slot.getAllByRole('progressbar')).toHaveLength(1);
 expect(slot.container.querySelector('.plan-line .state-badge')?.textContent).toBe('В работе');
 expect(slot.container.querySelector('.more-plans')).toBeNull();
 fireEvent.click(slot.getByText('Проверка → Тесты',{selector:'.progress-caption'}));
 await waitFor(()=>expect(slot.getAllByRole('progressbar')).toHaveLength(2));
 expect(slot.getByText('Второй план',{selector:'.additional-plan-title'})).toBeTruthy();
 expect(slot.getAllByText('Подготовка',{selector:'.plan-steps li'})).toHaveLength(1);
 fireEvent.click(slot.getByText('Проверка → Тесты',{selector:'.additional-plans .progress-caption'}));
 await waitFor(()=>expect(slot.getAllByText('Подготовка',{selector:'.plan-steps li'})).toHaveLength(2));
});
test('migration validates state and keys and compares JSON independent of object order',()=>{
 const full={...plan(),kind:'plan',createdAt:1};
 expect(migrationEntry.safeParse({key:'bars:thread-test',value:[full]}).success).toBe(true);
 expect(migrationEntry.safeParse({key:'secrets:thread-test',value:[full]}).success).toBe(false);
 expect(migrationEntry.safeParse({key:'bars:thread-test',value:[{...full,state:'invented'}]}).success).toBe(false);
 expect(sameRecord({a:1,b:[2,3]},{b:[2,3],a:1})).toBe(true);
 expect(sameRecord([1,2],[2,1])).toBe(false);
});

test('aggregate sums deepest planned branches without counting coordinator plans twice',()=>{
 const aggregate=aggregateProgress([
  {id:'coordinator',parentThreadId:null,title:'Coordinator',plans:[plan({stages:[{name:'Coordination',steps:[{title:'Wait',status:'pending'}]}]})]},
  {id:'worker',parentThreadId:'coordinator',title:'Worker',plans:[plan()]},
  {id:'review',parentThreadId:null,title:'Review',plans:[plan({stages:[{name:'Review',steps:[{title:'Review',status:'done'}]}],state:'done'})]},
 ])!;
 expect(planProgress(aggregate)).toMatchObject({done:2,total:4,percent:50});
 expect(aggregate.stages.map(s=>s.name).join(' ')).not.toContain('Coordination');
 expect(aggregateProgress([{id:'missing',parentThreadId:null,title:'Missing',plans:[]}])).toMatchObject({state:'running',note:'Без плана: 1',stages:[]});
});
test('completed phases remain in history while aggregate uses the latest plan per child',()=>{
 const history=[plan({id:'phase1',state:'done',hidden:'auto'}),plan({id:'phase2',state:'done',hidden:'auto'}),plan({id:'phase3'}),plan({id:'manual',hidden:'manual'})];
 expect(sidebarPlans(history).map(p=>p.id)).toEqual(['phase3','phase1','phase2']);
 const total=aggregateProgress([{id:'worker',parentThreadId:null,title:'Worker',plans:sidebarPlans(history)}])!;
 expect(planProgress(total)).toMatchObject({done:1,total:3});
 const slot=render(<ThreadProgress plans={sidebarPlans(history)}/>);
 expect(slot.queryByLabelText('Ещё планов: 2')).toBeNull();
 fireEvent.click(slot.getByRole('button',{name:'Показать готовые'}));
 expect(slot.getByLabelText('Ещё планов: 2')).toBeTruthy();
 fireEvent.click(slot.getByRole('button',{name:'Скрыть готовые'}));
 expect(slot.queryByLabelText('Ещё планов: 2')).toBeNull();
});
test('step and stage markers retain original elapsed time; current marker ticks and freezes on completion',async()=>{
 vi.useFakeTimers();vi.setSystemTime(10000);
 try {
  const timed=plan({createdAt:1000,stages:[{name:'Stage 1',steps:[{title:'Read',status:'done',startedAt:1000,endedAt:4000}]},{name:'Stage 2',steps:[{title:'Build',status:'active',startedAt:4000},{title:'Report',status:'pending'}]}]});
  expect(progressMarks(timed)[0]).toMatchObject({label:'Stage 1 · 3s',isStage:true});
  const slot=render(<PlanStrip plan={timed}/>);
  expect(slot.getByRole('img',{name:'Всего: 9s · Шаг: 6s'})).toBeTruthy();
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
  expect(slot.getByRole('img',{name:'Всего: 10s · Шаг: 7s'})).toBeTruthy();
  slot.rerender(<PlanStrip plan={{...timed,state:'done',endedAt:11000,stages:timed.stages.map(stage=>({...stage,steps:stage.steps.map(step=>({...step,status:'done',endedAt:11000}))}))}}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(slot.getByRole('img',{name:'Всего: 10s'})).toBeTruthy();
 } finally {cleanup();vi.useRealTimers();}
});

test('completed-only plans stay hidden until revealed, with the original completed track fill',()=>{
 const slot=render(<ThreadProgress plans={[plan({state:'done'})]}/>);
 expect(slot.queryByRole('progressbar')).toBeNull();
 fireEvent.click(slot.getByRole('button',{name:'Показать готовые'}));
 expect(slot.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
 expect(slot.container.querySelector('.progress-fraction')?.textContent).toBe('1/3');
 fireEvent.click(slot.getByRole('button',{name:'Скрыть готовые'}));
 expect(slot.queryByRole('progressbar')).toBeNull();
});
test('large closed histories are not mounted, and timer ticks do not rebuild their step list',async()=>{
 vi.useFakeTimers();vi.setSystemTime(10000);
 try {
  let reads=0;
  const steps=Array.from({length:200},(_,i)=>({get title(){reads++;return 'Step '+i;},status:'active' as const,startedAt:1000}));
  const slot=render(<PlanStrip plan={plan({createdAt:1000,stages:[{name:'Large',steps}]})}/>);
  expect(slot.container.querySelectorAll('li')).toHaveLength(0);
  const details=slot.container.querySelector('details')!;details.open=true;fireEvent(details,new Event('toggle'));
  expect(slot.container.querySelectorAll('li')).toHaveLength(200);
  const before=reads;
  await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  expect(reads).toBe(before);
  expect(slot.getByRole('img',{name:'Всего: 11s · Шаг: 11s'})).toBeTruthy();
  details.open=false;fireEvent(details,new Event('toggle'));expect(slot.container.querySelectorAll('li')).toHaveLength(0);
 } finally {cleanup();vi.useRealTimers();}
});
test('completed stages can be revealed without changing the aggregate percentage',async()=>{
 const p=plan({stages:[{name:'Finished stage',steps:[{title:'Closed work',status:'done'}]},{name:'Current stage',steps:[{title:'Open work',status:'active'}]}]});
 const slot=render(<ThreadProgress plans={[p]}/>);
 fireEvent.click(slot.getByText('Current stage → Open work'));
 expect(await slot.findByText('Open work')).toBeTruthy();
 expect(slot.queryByText('Closed work')).toBeNull();
 fireEvent.click(slot.getByRole('button',{name:'Показать готовые'}));
 expect(slot.getByText('Closed work')).toBeTruthy();
 expect(slot.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
});

test('dense aggregates keep at most twelve visible marks without losing timing labels',()=>{
 const p=plan({stages:[{name:'Stage',steps:Array.from({length:178},(_,i)=>({title:'Step '+i,status:'done',startedAt:i*1000,endedAt:(i+1)*1000}))}]});
 const original=progressMarks(p),compact=compactProgressMarks(p);
 expect(compact.length).toBeLessThanOrEqual(12);
 expect(compact.flatMap(m=>m.label.split('\n'))).toEqual(original.map(m=>m.label));
 const slot=render(<PlanStrip plan={p}/>);
 expect(slot.container.querySelectorAll('.pp-track-mark').length).toBeLessThanOrEqual(12);
 expect(compactProgressMarks(plan())).toEqual(progressMarks(plan()));
});

test('shared track retains stage/step head, boundary separators, passed marks and custom timing tips',()=>{
 const p=plan({createdAt:1000,stages:[{name:'First stage',steps:[{title:'Read',status:'done',startedAt:1000,endedAt:4000}]},{name:'Second stage',steps:[{title:'Build',status:'active',startedAt:4000},{title:'Report',status:'pending'}]}]});
 const slot=render(<PlanTrack plan={p} compact/>);
 expect(slot.container.querySelector('.pp-head-label')?.textContent).toBe('Second stageBuild');
 expect(slot.container.querySelector('.pp-stage-separator')).toBeTruthy();
 expect(slot.container.querySelector('.pp-track-mark.pp-track-passed .pp-track-tip')?.textContent).toBe('First stage · 3s');
 expect(slot.container.querySelectorAll('.pp-track-mark:not(.pp-track-passed)')).toHaveLength(1);
 expect(slot.getByRole('progressbar').style.height).toBe('20px');
 slot.rerender(<PlanTrack plan={p}/>);
 expect(slot.getByRole('progressbar').style.height).toBe('22px');
});
test.each(['needs_input','error','done'] as const)('shared head retains the %s state icon and note or finish time',state=>{
 const slot=render(<PlanTrack plan={plan({state,note:'Explain the blocker',createdAt:1000,endedAt:state==='done'?10000:undefined})}/>);
 expect(slot.container.querySelector('.pp-track-head svg path')).toBeTruthy();
 expect(slot.container.querySelector('.pp-head-label')?.textContent).toBe(state==='done'?'9s':'Explain the blocker');
 expect(slot.container.querySelector('.mspp-wave')).toBeTruthy();
});

test('aggregate head carries the blocking child note instead of an unrelated worker step',()=>{
 const aggregate=aggregateProgress([{id:'worker',parentThreadId:null,title:'Worker',plans:[plan()]},{id:'review',parentThreadId:null,title:'Review',plans:[plan({state:'needs_input',note:'Confirm requirements'})]}])!;
 expect(aggregate.note).toBe('Review: Confirm requirements');
 const slot=render(<PlanTrack plan={aggregate} compact/>);
 expect(slot.container.querySelector('.pp-head-label')?.textContent).toBe('Review: Confirm requirements');
});

test('aggregate counts an explicitly finished latest child plan without mutating saved step states',()=>{
 const finished=plan({id:'latest',state:'done',updatedAt:20,stages:[{name:'Work',steps:[{title:'Work',status:'active'},{title:'Report',status:'pending'}]}]});
 const aggregate=aggregateProgress([{id:'child',title:'Child',parentThreadId:null,plans:[plan({id:'old',updatedAt:1}),finished]}])!;
 expect(planProgress(aggregate)).toMatchObject({done:2,total:2,percent:100});
 expect(finished.stages[0]?.steps[0]?.status).toBe('active');
});
test('attention badge activation opens its destination without expanding the plan',()=>{
 let calls=0;
 const slot=render(<ThreadProgress plans={[plan({state:'error'})]} status={{label:'Ошибка',state:'error',onActivate:()=>calls++}}/>);
 fireEvent.click(slot.getByRole('button',{name:'Ошибка ↗'}));
 expect(calls).toBe(1);expect(slot.container.querySelector('details')?.open).toBe(false);
});
