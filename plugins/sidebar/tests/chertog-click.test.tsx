// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, cleanup, within } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import app from '../app';

afterEach(() => { cleanup(); localStorage.clear(); });
const make = (id: string, over: object = {}) => ({ id, projectId: 'p', status: 'active' as const, title: id, titleFallback: null, parentThreadId: null, parentNotifications: 'auto' as const, lifecycleOwnerThreadId: null, sourceThreadId: null, sectionId: null, originKind: null, originPluginId: null, providerId: 'test', pinnedAt: null, archivedAt: null, createdAt: 1, updatedAt: 1, lastReadAt: null, hasPendingInteraction: false, isUnread: false, isPinned: false, pinSortKey: null, isArchived: false, displayTitle: id, href: '/projects/p/threads/' + id, environment: null, host: null, isHidden: false, indicator: 'none' as const, indicatorLabel: null, runtimeStatus: 'active' as const, queuedWork: 'none' as const, activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 }, latestAttentionAt: 100, ...over });

const questionPlan = { id: 'plan', title: 'Plan', state: 'needs_input', updatedAt: 1, stages: [{ name: 'Stage', steps: [{ title: 'Step', status: 'active' }] }] };
async function render(onNavigate: () => void, planned = false) {
  const definition = await loadPluginApp(() => Promise.resolve({ default: app }));
  return renderSlot(definition.threadLists[0]!, { activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate, searchQuery: '' }, { sidebarThreads: { status: 'ready', projects: [{ id: 'p', name: 'Example', isPersonal: false, href: '/p', settingsHref: '/s' }], threads: [make('busy'), make('question', { status: 'idle', runtimeStatus: 'idle', hasPendingInteraction: true })], sections: [] }, rpc: { paths: () => [{ id: 'p', name: 'Example', path: null }], attention: () => ({ entries: [], incomplete: false }), progress: () => ({ availability: 'ready', entries: planned ? [{ threadId: 'question', plans: [questionPlan] }] : [], failedThreadIds: [] }) } });
}
const answer = (accepted: boolean, outcome: string | null, seen: string[]) => {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    seen.push(detail.threadId);
    detail.accepted = accepted; detail.outcome = outcome;
  };
  window.addEventListener('chertog.open.v1', handler);
  return () => window.removeEventListener('chertog.open.v1', handler);
};

test('thread row: accepted request keeps the user on the page and still closes the sidebar', async () => {
  const onNavigate = vi.fn(); const seen: string[] = [];
  const stop = answer(true, 'opened', seen);
  const slot = await render(onNavigate);
  const link = within(slot.getByRole('region', { name: 'Активные' })).getAllByRole('link', { name: /busy/ })[0]!;
  const notPrevented = fireEvent.click(link);
  stop();
  expect(seen).toEqual(['busy']);
  expect(notPrevented).toBe(false);
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  expect(onNavigate).toHaveBeenCalledTimes(1);
  slot.lifecycle.unmount();
});

test('thread row: no listener navigates as before', async () => {
  const onNavigate = vi.fn();
  const slot = await render(onNavigate);
  const link = within(slot.getByRole('region', { name: 'Активные' })).getAllByRole('link', { name: /busy/ })[0]!;
  fireEvent.click(link);
  expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: 'toThread', threadId: 'busy' });
  expect(onNavigate).toHaveBeenCalledTimes(1);
  slot.lifecycle.unmount();
});

test('thread row: not-shown reply navigates', async () => {
  const seen: string[] = []; const stop = answer(false, 'not-shown', seen);
  const slot = await render(() => { });
  fireEvent.click(within(slot.getByRole('region', { name: 'Активные' })).getAllByRole('link', { name: /busy/ })[0]!);
  stop();
  expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: 'toThread', threadId: 'busy' });
  slot.lifecycle.unmount();
});

test('thread row: modifier and non-left clicks send nothing', async () => {
  const seen: string[] = []; const stop = answer(true, 'opened', seen);
  const slot = await render(() => { });
  const link = within(slot.getByRole('region', { name: 'Активные' })).getAllByRole('link', { name: /busy/ })[0]!;
  const block = (event: Event) => event.preventDefault(); // the browser would follow the link; jsdom cannot
  document.addEventListener('click', block);
  fireEvent.click(link, { metaKey: true });
  fireEvent.click(link, { ctrlKey: true });
  fireEvent.click(link, { shiftKey: true });
  fireEvent.click(link, { altKey: true });
  fireEvent.click(link, { button: 1 });
  document.removeEventListener('click', block);
  stop();
  expect(seen).toEqual([]);
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  slot.lifecycle.unmount();
});

test('attention row: accepted request sends the same id and does not navigate', async () => {
  const onNavigate = vi.fn(); const seen: string[] = []; const stop = answer(true, 'focused', seen);
  const slot = await render(onNavigate);
  const inbox = within(slot.getByRole('region', { name: 'Требует внимания' }));
  fireEvent.click(inbox.getByRole('link', { name: /question/ }));
  stop();
  expect(seen).toEqual(['question']);
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  expect(onNavigate).toHaveBeenCalledTimes(1);
  slot.lifecycle.unmount();
});

test('attention row: unsupported reply navigates to the same thread', async () => {
  const onNavigate = vi.fn(); const seen: string[] = []; const stop = answer(false, 'unsupported', seen);
  const slot = await render(onNavigate);
  fireEvent.click(within(slot.getByRole('region', { name: 'Требует внимания' })).getByRole('link', { name: /question/ }));
  stop();
  expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: 'toThread', threadId: 'question' });
  expect(onNavigate).toHaveBeenCalledTimes(1);
  slot.lifecycle.unmount();
});

test('status badge: accepted request keeps the user on the page', async () => {
  const onNavigate = vi.fn(); const seen: string[] = []; const stop = answer(true, 'opened', seen);
  const slot = await render(onNavigate, true);
  const badge = await slot.findByRole('button', { name: 'Нужен ответ ↗' });
  fireEvent.click(badge);
  stop();
  expect(seen).toEqual(['question']);
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  expect(onNavigate).toHaveBeenCalledTimes(1);
  slot.lifecycle.unmount();
});

test('status badge: no listener navigates as before', async () => {
  const onNavigate = vi.fn();
  const slot = await render(onNavigate, true);
  fireEvent.click(await slot.findByRole('button', { name: 'Нужен ответ ↗' }));
  expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: 'toThread', threadId: 'question' });
  expect(onNavigate).toHaveBeenCalledTimes(1);
  slot.lifecycle.unmount();
});
