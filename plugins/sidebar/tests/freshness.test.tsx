// @vitest-environment jsdom
import {afterEach,expect,test,vi} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {ProgressFreshness} from '../src/ui/progress-freshness';
afterEach(()=>{cleanup();vi.useRealTimers();});
test('manual checking does not pretend that an old agent plan was updated',async()=>{
 vi.useFakeTimers();vi.setSystemTime(200000);let refreshes=0;
 const slot=render(<ProgressFreshness updatedAt={1} checkedAt={190000} failed={false} running onRefresh={()=>refreshes++}/>);
 expect(slot.getByText('План не обновлялся 3 мин')).toBeTruthy();
 fireEvent.click(slot.getByRole('button',{name:'Проверить ↻'}));expect(refreshes).toBe(1);
 slot.rerender(<ProgressFreshness updatedAt={1} checkedAt={200000} failed={false} running onRefresh={()=>refreshes++}/>);
 expect(slot.getByText('План не обновлялся 3 мин')).toBeTruthy();
 await act(async()=>{await vi.advanceTimersByTimeAsync(40000);});
 expect(slot.getByText('План не обновлялся 3 мин')).toBeTruthy();
});
