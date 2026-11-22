// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { requestChertogTile } from '../src/adapters/bb/chertog-open';

type Detail = { kind: string; threadId: string; accepted: boolean; outcome: string | null };
const listeners: Array<(event: Event) => void> = [];
const listen = (fn: (detail: Detail) => void) => {
  const handler = (event: Event) => fn((event as CustomEvent<Detail>).detail);
  listeners.push(handler);
  window.addEventListener('chertog.open.v1', handler);
};
afterEach(() => { while (listeners.length) window.removeEventListener('chertog.open.v1', listeners.pop()!); });

test('without a listener the request is not accepted', () => {
  expect(requestChertogTile('thr_1')).toBe(false);
});

test('sends the closed thread request shape with accepted false and outcome null', () => {
  let seen: Detail | null = null;
  listen(detail => { seen = { ...detail }; });
  requestChertogTile('thr_1');
  expect(seen).toEqual({ kind: 'thread', threadId: 'thr_1', accepted: false, outcome: null });
});

test('accepted outcomes (opened, focused, refused) mean Chertog handled it', () => {
  for (const outcome of ['opened', 'focused', 'refused']) {
    listen(detail => { detail.accepted = true; detail.outcome = outcome; });
    expect(requestChertogTile('thr_1')).toBe(true);
    while (listeners.length) window.removeEventListener('chertog.open.v1', listeners.pop()!);
  }
});

test('not-shown, unsupported and invalid replies fall back to navigation', () => {
  for (const outcome of ['not-shown', 'unsupported', 'invalid']) {
    listen(detail => { detail.outcome = outcome; });
    expect(requestChertogTile('thr_1')).toBe(false);
    while (listeners.length) window.removeEventListener('chertog.open.v1', listeners.pop()!);
  }
});

test('a throwing listener does not break the click: falls back to navigation', () => {
  const original = window.dispatchEvent.bind(window);
  window.dispatchEvent = () => { throw new Error('boom'); };
  try {
    expect(requestChertogTile('thr_1')).toBe(false);
  } finally {
    window.dispatchEvent = original;
  }
});
