// @vitest-environment jsdom
import React from 'react';
import { it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { NavigationRail } from './navigation-rail';
afterEach(cleanup);
it('replaces the menu list on entering a nested group and returns with Back', () => {
    render(<NavigationRail nodes={[{ kind: 'group', id: 'g', name: 'Общение', icon: 'Folder', hidden: false, children: [{ kind: 'group', id: 'nested', name: 'Рабочее', icon: 'Folder', hidden: false, children: [{ kind: 'item', id: 'm', itemId: 'mail', hidden: false }] }] }]} labels={{ mail: 'Почта' }} onActivate={vi.fn()} onHome={vi.fn()}/>);
    fireEvent.click(screen.getByLabelText('Общение'));
    fireEvent.click(screen.getByText('Рабочее'));
    expect(screen.getByText('Почта')).toBeTruthy();
    fireEvent.click(screen.getByText('Назад'));
    expect(screen.queryByText('Почта')).toBeNull();
});
it('focuses a menu item, returns focus on Escape and aggregates badge without summing', () => {
    render(<NavigationRail nodes={[{ kind: 'group', id: 'g', name: 'Общение', icon: 'Folder', hidden: false, children: [{ kind: 'item', id: 'm', itemId: 'mail', hidden: false }] }]} labels={{ mail: 'Почта' }} badges={{ mail: {count:3,label:'3 непрочитанных'} }} onActivate={vi.fn()} onHome={vi.fn()}/>);
    const trigger = screen.getByRole('button', { name: /Общение/ });
    fireEvent.click(trigger);
    expect(document.activeElement?.getAttribute('data-node-id')).toBe('m');
    expect(screen.getAllByLabelText('Есть уведомления').length).toBeGreaterThan(0);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
});
it('renders badge values instead of their descriptive labels and caps rail counts',()=>{
 render(<NavigationRail nodes={[{kind:'item',id:'mail',itemId:'mail',hidden:false},{kind:'item',id:'updates',itemId:'updates',hidden:false}]} labels={{mail:'Почта',updates:'Обновления'}} badges={{mail:{count:42,label:'42 unread messages'},updates:{text:'NEW',label:'Updates available'}}} onActivate={vi.fn()} onHome={vi.fn()}/>);
 const mail=screen.getByRole('button',{name:/Почта/});expect(mail.textContent).toContain('9+');expect(mail.textContent).not.toContain('unread');expect(mail.getAttribute('aria-label')).toContain('42 unread messages');
 const updates=screen.getByRole('button',{name:/Обновления/});expect(updates.textContent).toContain('●');expect(updates.textContent).not.toContain('Updates available');expect(updates.getAttribute('title')).toContain('Updates available');
});
