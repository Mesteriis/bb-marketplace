// @vitest-environment jsdom
import {afterEach,expect,test} from 'vitest';
import {cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {PlanStrip,ThreadProgress} from '../src/ui/thread-progress';
import {planProgress,visiblePlans,type Plan} from '../src/core/progress';
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
test('collapsed plan shows its progress; opening reveals stages without navigation',()=>{
 const slot=render(<PlanStrip plan={plan()}/>);
 expect(slot.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('33');
 fireEvent.click(slot.getByText('Проверка → Тесты'));
 expect(slot.getByText('Подготовка')).toBeTruthy();
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
 expect(slot.getAllByText('Подготовка')).toHaveLength(2);
});
test('migration validates state and keys and compares JSON independent of object order',()=>{
 const full={...plan(),kind:'plan',createdAt:1};
 expect(migrationEntry.safeParse({key:'bars:thread-test',value:[full]}).success).toBe(true);
 expect(migrationEntry.safeParse({key:'secrets:thread-test',value:[full]}).success).toBe(false);
 expect(migrationEntry.safeParse({key:'bars:thread-test',value:[{...full,state:'invented'}]}).success).toBe(false);
 expect(sameRecord({a:1,b:[2,3]},{b:[2,3],a:1})).toBe(true);
 expect(sameRecord([1,2],[2,1])).toBe(false);
});
