import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePost, validateCategory, validateWebsite, calendarDays, importPosts, savePosts, loadPosts, importWorkspace, saveWorkspace, loadWorkspace, STORAGE_KEY, escapeHTML } from '../lib.js';

const post = (fields = {}) => ({ id: 'post-one', title: 'Unsere neue Kollektion', content: 'Bald verfügbar!', platform: 'Instagram', status: 'draft', date: '', time: '', image: '', ...fields });
const category = (fields = {}) => ({ id: 'category-one', name: 'Produkte', color: '#7c3aed', ...fields });
const website = (fields = {}) => ({ id: 'website-one', name: 'EMC Website', url: 'https://example.com/', platform: 'Website', kind: 'website', ...fields });

function mockStorage(initial) {
  const values = new Map(initial == null ? [] : [[STORAGE_KEY, initial]]);
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  return values;
}

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
  assert.throws(() => importPosts(JSON.stringify({ version: 3, posts: [] })), /nicht unterstützt/);
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
  const values = mockStorage();
  assert.deepEqual(loadPosts(), []);
  savePosts([post()]);
  assert.equal(loadPosts()[0].title, post().title);
  const before = values.get(STORAGE_KEY);
  assert.throws(() => savePosts([post({ title: '' })]));
  assert.equal(values.get(STORAGE_KEY), before);
  values.set(STORAGE_KEY, '{corrupt');
  assert.throws(loadPosts, /bleiben erhalten/);
  assert.equal(values.get(STORAGE_KEY), '{corrupt');
  values.set(STORAGE_KEY, before);
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => savePosts([post()]), /Gerätespeicher/);
  assert.equal(values.get(STORAGE_KEY), before);
});

test('legacy backups and saved arrays migrate without rewriting the original data', () => {
  const legacyPost = post({ createdAt: '2026-10-06T08:00:00.000Z', updatedAt: '2026-10-06T09:00:00.000Z' });
  for (const data of [[legacyPost], { version: 1, posts: [legacyPost] }]) {
    const raw = JSON.stringify(data);
    const values = mockStorage(raw);
    const workspace = loadWorkspace();
    assert.equal(workspace.version, 2);
    assert.deepEqual(workspace.categories, []);
    assert.deepEqual(workspace.websites, []);
    assert.equal(workspace.posts[0].categoryId, '');
    assert.equal(workspace.posts[0].channelId, '');
    assert.equal(workspace.posts[0].content, post().content);
    assert.equal(values.get(STORAGE_KEY), raw);
    assert.deepEqual(importWorkspace(raw), workspace);
  }
});

test('categories normalize names and colors and reject unusable or unsafe fields', () => {
  assert.deepEqual(validateCategory(category({ name: '  Produkte  ', color: '#ABCDEF' })), category({ color: '#abcdef' }));
  assert.throws(() => validateCategory(category({ name: '   ' })), /Kategorienamen/);
  assert.throws(() => validateCategory(category({ name: 'x'.repeat(41) })), /40/);
  assert.throws(() => validateCategory(category({ id: 'x'.repeat(101) })), /Kategorienkennung/);
  for (const color of ['red', '#abc', '#123456;background:red', 'url(javascript:alert(1))']) {
    assert.throws(() => validateCategory(category({ color })), /Kategorienfarbe/);
  }
  assert.throws(() => validateCategory([]), /Format/);
});

test('workspace enforces category limits, unique identifiers and case-insensitive names', () => {
  const backup = categories => JSON.stringify({ version: 2, posts: [], categories });
  assert.throws(() => importWorkspace(backup([category(), category({ name: 'Andere' })])), /doppelte Kategorienkennungen/);
  assert.throws(() => importWorkspace(backup([category(), category({ id: 'other', name: ' PRODUKTE ' })])), /eindeutig/);
  assert.throws(() => importWorkspace(backup(Array.from({ length: 101 }, (_, i) => category({ id: `${i}`, name: `Kategorie ${i}` })))), /100 Kategorien/);
  assert.throws(() => importWorkspace(JSON.stringify({ version: 2, posts: [], categories: {} })), /Kategorien/);
});

test('category creation, renaming and deletion keep post references consistent', () => {
  const values = mockStorage();
  saveWorkspace({ posts: [post()], categories: [category()] });
  saveWorkspace({ posts: [post({ categoryId: 'category-one' })], categories: [category({ name: 'Aktionen' })] });
  assert.equal(loadWorkspace().categories[0].name, 'Aktionen');
  assert.equal(loadWorkspace().posts[0].categoryId, 'category-one');
  const before = values.get(STORAGE_KEY);
  assert.throws(() => saveWorkspace({ posts: [post({ categoryId: 'category-one' })], categories: [] }), /unbekannte Kategorie/);
  assert.equal(values.get(STORAGE_KEY), before);
  saveWorkspace({ posts: [post({ categoryId: '' })], categories: [] });
  assert.deepEqual(loadWorkspace().categories, []);
  assert.equal(loadWorkspace().posts[0].categoryId, '');
});

test('new backup roundtrip preserves category and channel references and compatibility APIs', () => {
  mockStorage();
  const workspace = saveWorkspace({ posts: [post({ categoryId: 'category-one', channelId: 'instagram-page-42' })], categories: [category()] });
  assert.deepEqual(importWorkspace(JSON.stringify(workspace)), workspace);
  assert.deepEqual(importPosts(JSON.stringify(workspace)), workspace.posts);
  savePosts([{ ...workspace.posts[0], title: 'Überarbeitet' }]);
  const restored = loadWorkspace();
  assert.deepEqual(restored.categories, workspace.categories);
  assert.equal(restored.posts[0].categoryId, 'category-one');
  assert.equal(restored.posts[0].channelId, 'instagram-page-42');
  assert.equal(restored.posts[0].title, 'Überarbeitet');
});

test('invalid category imports and blocked saves do not replace existing workspace', () => {
  const values = mockStorage();
  const workspace = saveWorkspace({ posts: [post()], categories: [category()] });
  const before = values.get(STORAGE_KEY);
  assert.throws(() => importWorkspace(JSON.stringify({ version: 2, posts: [post({ categoryId: 'missing' })], categories: [category()] })), /unbekannte Kategorie/);
  assert.throws(() => saveWorkspace({ posts: workspace.posts, categories: [category({ color: 'red' })] }), /Kategorienfarbe/);
  assert.equal(values.get(STORAGE_KEY), before);
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => saveWorkspace({ posts: [], categories: [] }), /Gerätespeicher/);
  assert.equal(values.get(STORAGE_KEY), before);
});

test('legacy APIs never overwrite a corrupt saved workspace or store unknown fields', () => {
  const values = mockStorage('{corrupt');
  assert.throws(() => savePosts([post()]), /bleiben erhalten/);
  assert.equal(values.get(STORAGE_KEY), '{corrupt');
  saveWorkspace({ posts: [post({ accessToken: 'should-not-be-stored' })], categories: [category()], accessToken: 'should-not-be-stored' });
  assert.equal(values.get(STORAGE_KEY).includes('should-not-be-stored'), false);
  assert.throws(() => validatePost(post({ categoryId: 'x'.repeat(101) })), /Kategorienkennung/);
  assert.throws(() => validatePost(post({ channelId: 'x'.repeat(101) })), /Kanalkennung/);
});

test('websites normalize HTTPS addresses and omit unsupported fields', () => {
  assert.deepEqual(validateWebsite(website({ name: '  EMC Website  ', url: 'HTTPS://EXAMPLE.COM', accessToken: 'secret', platform: 'Instagram', kind: 'oauth' })), website());
  assert.equal(validateWebsite(website({ url: 'https://example.com/news?q=campaign' })).url, 'https://example.com/news?q=campaign');
  assert.throws(() => validateWebsite(website({ name: ' ' })), /Websitenamen/);
  assert.throws(() => validateWebsite(website({ name: 'x'.repeat(81) })), /80/);
  assert.throws(() => validateWebsite(website({ id: 'x'.repeat(101) })), /Websitekennung/);
  assert.throws(() => validateWebsite(website({ url: `https://example.com/${'x'.repeat(2048)}` })), /2.048/);
});

test('website addresses reject script schemes, credentials and fragments', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'http://example.com', '//example.com', 'not a url', 'https://user@example.com', 'https://user:password@example.com', 'https://example.com/#access_token=secret']) {
    assert.throws(() => validateWebsite(website({ url })), /HTTPS/);
  }
});

test('older v2 workspaces gain an empty website collection without losing data', () => {
  const oldWorkspace = { version: 2, posts: [validatePost(post({ categoryId: 'category-one' }))], categories: [category()] };
  const raw = JSON.stringify(oldWorkspace);
  const values = mockStorage(raw);
  assert.deepEqual(loadWorkspace(), { ...oldWorkspace, websites: [] });
  assert.equal(values.get(STORAGE_KEY), raw);
  mockStorage();
  assert.deepEqual(loadWorkspace(), { version: 2, posts: [], categories: [], websites: [] });
});

test('website backups roundtrip and legacy saves preserve the website collection', () => {
  const values = mockStorage();
  const saved = saveWorkspace({ posts: [post({ platform: 'Website', channelId: 'website-one' })], categories: [], websites: [website({ accessToken: 'do-not-store' })] });
  assert.deepEqual(importWorkspace(JSON.stringify(saved)), saved);
  assert.equal(values.get(STORAGE_KEY).includes('do-not-store'), false);
  savePosts([{ ...saved.posts[0], title: 'Website News' }]);
  assert.deepEqual(loadWorkspace().websites, saved.websites);
  assert.equal(loadPosts()[0].channelId, 'website-one');
  assert.equal(loadPosts()[0].platform, 'Website');
});

test('website limits and references validate atomically when adding or deleting a site', () => {
  const values = mockStorage();
  const saved = saveWorkspace({ posts: [post({ platform: 'Website', channelId: 'website-one' })], categories: [], websites: [website()] });
  const before = values.get(STORAGE_KEY);
  const backup = websites => JSON.stringify({ version: 2, posts: [], categories: [], websites });
  assert.throws(() => importWorkspace(backup([website(), website({ name: 'Other', url: 'https://other.example/' })])), /doppelte Websitekennungen/);
  assert.throws(() => importWorkspace(backup([website(), website({ id: 'other', url: 'HTTPS://EXAMPLE.COM' })])), /nur einmal/);
  assert.throws(() => importWorkspace(backup(Array.from({ length: 101 }, (_, i) => website({ id: `${i}`, url: `https://example.com/${i}` })))), /100 Websites/);
  assert.throws(() => importWorkspace(backup(null)), /Websites/);
  assert.throws(() => saveWorkspace({ ...saved, websites: [] }), /unbekannte Website/);
  assert.throws(() => saveWorkspace({ ...saved, posts: [post({ platform: 'Instagram', channelId: 'website-one' })] }), /Plattform Website/);
  assert.equal(values.get(STORAGE_KEY), before);
  saveWorkspace({ ...saved, posts: [{ ...saved.posts[0], channelId: '' }], websites: [] });
  assert.deepEqual(loadWorkspace().websites, []);
  assert.equal(loadWorkspace().posts[0].channelId, '');
});

test('HTML escaping treats imported text as inert content', () => {
  assert.equal(escapeHTML('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});
