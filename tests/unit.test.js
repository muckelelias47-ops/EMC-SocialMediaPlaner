import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePost, calendarDays, importPosts, savePosts, loadPosts, STORAGE_KEY, escapeHTML } from '../lib.js';

const post = (fields = {}) => ({ id: 'post-one', title: 'Unsere neue Kollektion', content: 'Bald verfügbar!', platform: 'Instagram', status: 'draft', date: '', time: '', image: '', ...fields });

test('normalizes a draft and preserves creation time when editing', () => {
  const first = validatePost(post({ title: '  Kollektion  ' }));
  const edit = validatePost({ ...first, title: 'Neu' });
  assert.equal(first.title, 'Kollektion');
  assert.equal(edit.createdAt, first.createdAt);
  assert.equal(edit.id, first.id);
});

test('planned posts require a real local date and time', () => {
  assert.throws(() => validatePost(post({ status: 'planned' })), /Datum/);
  assert.throws(() => validatePost(post({ status: 'planned', date: '2026-02-30', time: '10:00' })), /gültiges Datum/);
  assert.throws(() => validatePost(post({ date: '2026-10-06', time: '24:00' })), /Uhrzeit/);
  assert.equal(validatePost(post({ status: 'planned', date: '2028-02-29', time: '23:59' })).date, '2028-02-29');
});

test('rejects unsupported platform, state and excessive content', () => {
  assert.throws(() => validatePost(post({ platform: 'unknown' })), /Plattform/);
  assert.throws(() => validatePost(post({ status: 'auto-published' })), /Status/);
  assert.throws(() => validatePost(post({ content: 'x'.repeat(10001) })), /10.000/);
});

test('only accepts bounded raster data images', () => {
  assert.throws(() => validatePost(post({ image: 'data:image/svg+xml;base64,PHN2Zz4=' })), /Bild/);
  assert.throws(() => validatePost(post({ image: 'https://example.com/pixel.png' })), /Bild/);
  assert.equal(validatePost(post({ image: 'data:image/png;base64,YWJj' })).image, 'data:image/png;base64,YWJj');
});

test('backup validation is atomic and rejects duplicate ids', () => {
  assert.equal(importPosts(JSON.stringify({ version: 1, posts: [post()] })).length, 1);
  assert.equal(importPosts(JSON.stringify([post()])).length, 1);
  assert.throws(() => importPosts(JSON.stringify({ version: 2, posts: [] })), /nicht unterstützt/);
  assert.throws(() => importPosts(JSON.stringify([post(), post()])), /doppelte/);
  assert.throws(() => importPosts(JSON.stringify([post(), post({ title: '' })])), /Titel/);
  assert.throws(() => importPosts('bad JSON'), /JSON/);
});

test('calendar starts Monday and crosses year and leap-month boundaries correctly', () => {
  const october = calendarDays(2026, 9);
  assert.equal(october.length, 42);
  assert.equal(october[0].date, '2026-09-28');
  assert.equal(october.filter(day => day.inMonth).length, 31);
  assert.equal(calendarDays(2028, 1).filter(day => day.inMonth).length, 29);
  assert.equal(calendarDays(2027, 0)[0].date, '2026-12-28');
});

test('saved data reloads, corrupt data is preserved, and quota errors surface', () => {
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.deepEqual(loadPosts(), []);
  savePosts([post()]);
  assert.equal(loadPosts()[0].title, post().title);
  const before = values.get(STORAGE_KEY);
  assert.throws(() => savePosts([post({ title: '' })]));
  assert.equal(values.get(STORAGE_KEY), before);
  values.set(STORAGE_KEY, '{corrupt');
  assert.throws(loadPosts, /bleiben erhalten/);
  assert.equal(values.get(STORAGE_KEY), '{corrupt');
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => savePosts([post()]), /Gerätespeicher/);
});

test('HTML escaping treats imported text as inert content', () => {
  assert.equal(escapeHTML('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});
