import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore, readEncryptionKey } from './store.js';

async function fixture(t, now) {
  const directory = await mkdtemp(join(tmpdir(), 'emc-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const store = await new EncryptedStore({ directory, key, now }).init();
  return { store, directory, key };
}

function channel(accountId = 'account-123') {
  return { provider: 'youtube', platform: 'YouTube', accountId, name: 'Demo channel', tokens: { accessToken: 'private-provider-access-token', refreshToken: 'private-refresh-token' } };
}

test('encryption key requires exactly 32 bytes in canonical base64', () => {
  const key = randomBytes(32);
  assert.deepEqual(readEncryptionKey(key.toString('base64')), key);
  for (const value of ['', undefined, 'pretend-secret', randomBytes(24).toString('base64'), key.toString('base64').replace('=', ''), `${key.toString('base64')}\n`]) assert.equal(readEncryptionKey(value), null);
});

test('encrypted persistence redacts tokens, survives reload, and uses owner-only file permissions', async (t) => {
  const { store, directory, key } = await fixture(t);
  const session = await store.createSession();
  await store.addChannels(session.sessionToken, [channel()]);
  const response = store.listChannels(session.sessionToken);
  assert.equal(response.channels.length, 1);
  assert.equal(response.channels[0].accountId, 'account-123');
  assert.equal(JSON.stringify(response).includes('private-'), false);
  assert.equal('tokens' in response.channels[0], false);
  const file = join(directory, 'channels.enc.json');
  const content = await readFile(file, 'utf8');
  for (const secret of ['private-provider-access-token', 'private-refresh-token', session.sessionToken, 'account-123']) assert.equal(content.includes(secret), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const restored = await new EncryptedStore({ directory, key }).init();
  assert.deepEqual(restored.listChannels(session.sessionToken), response);
  await assert.rejects(new EncryptedStore({ directory, key: randomBytes(32) }).init(), /could not be opened/);
});

test('sessions isolate channels and removing another session channel has no effect', async (t) => {
  const { store } = await fixture(t);
  const first = await store.createSession();
  const second = await store.createSession();
  await store.addChannels(first.sessionToken, [channel()]);
  const id = store.listChannels(first.sessionToken).channels[0].id;
  assert.equal(store.listChannels(second.sessionToken).channels.length, 0);
  assert.equal(await store.removeChannel(second.sessionToken, id), false);
  assert.equal(store.listChannels(first.sessionToken).channels.length, 1);
  assert.equal(await store.removeChannel(first.sessionToken, id), true);
  assert.equal(store.listChannels(first.sessionToken).channels.length, 0);
});

test('same provider identity updates while distinct accounts remain connected', async (t) => {
  const { store } = await fixture(t);
  const session = await store.createSession();
  await Promise.all([store.addChannels(session.sessionToken, [channel('first')]), store.addChannels(session.sessionToken, [channel('second')])]);
  const before = store.listChannels(session.sessionToken).channels;
  assert.equal(before.length, 2);
  await store.addChannels(session.sessionToken, [{ ...channel('first'), name: 'Renamed' }]);
  const after = store.listChannels(session.sessionToken).channels;
  assert.equal(after.length, 2);
  assert.equal(after.find((item) => item.accountId === 'first').id, before.find((item) => item.accountId === 'first').id);
  assert.equal(after.find((item) => item.accountId === 'first').name, 'Renamed');
});

test('expired sessions cannot read, add, or delete channels', async (t) => {
  let timestamp = Date.now();
  const { store } = await fixture(t, () => timestamp);
  const session = await store.createSession();
  await store.addChannels(session.sessionToken, [channel()]);
  const id = store.listChannels(session.sessionToken).channels[0].id;
  timestamp += 31 * 24 * 60 * 60 * 1000;
  assert.equal(store.listChannels(session.sessionToken), null);
  await assert.rejects(store.addChannels(session.sessionToken, [channel()]), /expired/);
  assert.equal(await store.removeChannel(session.sessionToken, id), false);
  const next = await store.createSession();
  assert.equal(store.listChannels(next.sessionToken).channels.length, 0);
});


test('encrypted storage rejects shortened GCM authentication tags', async (t) => {
  const { store, directory, key } = await fixture(t);
  await store.createSession();
  const file = join(directory, 'channels.enc.json');
  const envelope = JSON.parse(await readFile(file, 'utf8'));
  envelope.tag = Buffer.from(envelope.tag, 'base64').subarray(0, 4).toString('base64');
  await writeFile(file, JSON.stringify(envelope));
  await assert.rejects(new EncryptedStore({ directory, key }).init(), /could not be opened/);
});


test('expired provider tokens expose a reconnect deadline without exposing credentials', async (t) => {
  let timestamp = Date.now();
  const { store } = await fixture(t, () => timestamp);
  const session = await store.createSession();
  const expiresAt = new Date(timestamp + 60000).toISOString();
  await store.addChannels(session.sessionToken, [{ ...channel(), tokens: { accessToken: 'private-provider-access-token', refreshToken: 'private-refresh-token', expiresAt } }]);
  let visible = store.listChannels(session.sessionToken).channels[0];
  assert.equal(visible.requiresReconnect, false);
  assert.equal(visible.tokenExpiresAt, expiresAt);
  timestamp += 60000;
  visible = store.listChannels(session.sessionToken).channels[0];
  assert.equal(visible.requiresReconnect, true);
  assert.equal(JSON.stringify(visible).includes('private-'), false);
  assert.equal('tokens' in visible, false);
  await store.addChannels(session.sessionToken, [channel()]);
  assert.equal(store.listChannels(session.sessionToken).channels[0].requiresReconnect, false);
});
