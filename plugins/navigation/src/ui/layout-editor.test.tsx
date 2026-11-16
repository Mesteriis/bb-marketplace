// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { LayoutEditor } from './layout-editor';
afterEach(cleanup);
it('creates a group in settings and hides an existing item without deleting it', () => {
    const edit = vi.fn();
    render(<LayoutEditor nodes={[{ kind: 'item', id: 'm', itemId: 'mail', hidden: false }]} labels={{ mail: 'Почта' }} onChange={edit}/>);
    fireEvent.click(screen.getByText('＋ Группа'));
    expect(edit.mock.calls[0][0][1].kind).toBe('group');
    fireEvent.click(screen.getByLabelText('Показывать Почта'));
    expect(edit.mock.calls[1][0]).toEqual([{ kind: 'item', id: 'm', itemId: 'mail', hidden: true }]);
});
it('filters group icons and resets only after explicit confirmation', () => {
    const edit = vi.fn();
    render(<LayoutEditor nodes={[{ kind: 'group', id: 'g', name: 'Группа', icon: 'Folder', hidden: false, children: [] }]} labels={{}} onChange={edit} resetNodes={[]}/>);
    fireEvent.click(screen.getByText('▸ Группа'));
    fireEvent.change(screen.getByLabelText('Поиск иконок'), { target: { value: 'mail' } });
    expect(screen.getByRole('option', { name: 'Mail' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Code' })).toBeNull();
    fireEvent.click(screen.getByText('Сбросить раскладку'));
    expect(edit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Подтвердить сброс'));
    expect(edit).toHaveBeenCalledWith([]);
});
