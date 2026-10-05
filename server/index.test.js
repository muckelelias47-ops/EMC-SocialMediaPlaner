import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './index.js';

const frontend = 'https://frontend.example.test';
const publicBackend = 'https://api.example.test';

async function fixture(t, { env: overrides = {}, providerFetch, now } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'emc-api-'));
  const calls = [];
  const remoteFetch = providerFetch || (async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'private-access-token', refresh_token: 'private-refresh-token', token_type: 'Bearer', expires_in: 3600 });
    if (String(url).startsWith('https://www.googleapis.com/youtube/v3/channels')) return Response.json({ items: [{ id: 'youtube-channel-a', snippet: { title: 'First channel', customUrl: '@first' } }, { id: 'youtube-channel-b', snippet: { title: 'Second channel' } }] });
    throw new Error('Unexpected remote endpoint.');
  });
  const env = { PORT: '0', HOST: '127.0.0.1', PUBLIC_BASE_URL: publicBackend, FRONTEND_ORIGIN: frontend, CHANNEL_ENCRYPTION_KEY: randomBytes(32).toString('base64'), DATA_DIR: directory, GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'private-client-secret', ...overrides };
  const service = await startServer({ env, fetch: remoteFetch, now });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.port}`;
  const request = (path, options = {}) => fetch(`${base}${path}`, options);
  const post = (path, token, body = {}, origin = frontend) => request(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const session = async () => {
    const result = await post('/api/session');
    assert.equal(result.status, 201);
    return (await result.json()).sessionToken;
  };
  const connect = async (token, provider = 'youtube') => {
    const result = await post(`/api/connect/${provider}`, token);
    assert.equal(result.status, 200);
    const url = new URL((await result.json()).authorizationUrl);
    assert.equal(url.origin, publicBackend);
    return { state: url.searchParams.get('state'), path: `${url.pathname}${url.search}` };
  };
  const bind = async (token, state) => {
    const response = await post('/api/oauth/bind', token, { state }, publicBackend);
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], authorizationUrl: (await response.json()).authorizationUrl };
  };
  const callback = (state, cookie, query = 'code=demo-code', provider = 'youtube') => request(`/oauth/${provider}/callback?state=${encodeURIComponent(state)}&${query}`, { headers: cookie ? { Cookie: cookie } : {} });
  const channels = async (token) => {
    const result = await request('/api/channels', { headers: { Authorization: `Bearer ${token}`, Origin: frontend } });
    assert.equal(result.status, 200);
    return result.json();
  };
  return { request, post, session, connect, bind, callback, channels, calls };
}

test('safe config reports real readiness and never contains app secrets', async (t) => {
  const f = await fixture(t);
  const result = await f.request('/api/config', { headers: { Origin: frontend } });
  assert.equal(result.headers.get('access-control-allow-origin'), frontend);
  const config = await result.json();
  assert.equal(config.providers.length, 6);
  assert.equal(config.providers.find((item) => item.id === 'youtube').authorizationReady, true);
  assert.equal(config.providers.find((item) => item.id === 'x').authorizationReady, false);
  assert.equal(JSON.stringify(config).includes('private-client-secret'), false);
});

test('missing encryption key and insecure nonlocal URLs disable sessions and OAuth', async (t) => {
  const f = await fixture(t, { env: { CHANNEL_ENCRYPTION_KEY: '', PUBLIC_BASE_URL: 'http://api.example.test' } });
  const config = await (await f.request('/api/config')).json();
  assert.equal(config.sessionReady, false);
  assert.equal(config.providers.every((item) => !item.authorizationReady), true);
  const response = await f.post('/api/session');
  assert.equal(response.status, 503);
});

test('trimmed empty provider credentials are unconfigured', async (t) => {
  const f = await fixture(t, { env: { GOOGLE_CLIENT_ID: '  ', GOOGLE_CLIENT_SECRET: '  ' } });
  const config = await (await f.request('/api/config')).json();
  const provider = config.providers.find((item) => item.id === 'youtube');
  assert.equal(provider.configured, false);
  assert.equal(provider.authorizationReady, false);
  assert.ok(provider.missingConfiguration.includes('GOOGLE_CLIENT_ID'));
});

test('origin checks reject untrusted mutation, absent origin, and wrong CORS origin', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/session', null, {}, 'https://attacker.example.test')).status, 403);
  assert.equal((await f.request('/api/session', { method: 'POST' })).status, 403);
  assert.equal((await f.request('/api/config', { headers: { Origin: 'https://attacker.example.test' } })).status, 403);
  const response = await f.request('/api/channels', { method: 'OPTIONS', headers: { Origin: frontend } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), frontend);
});

test('sessions use high entropy bearer and channels require valid credentials', async (t) => {
  const f = await fixture(t);
  const token = await f.session();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.channels(token)).channels.length, 0);
  assert.equal((await f.request('/api/channels')).status, 401);
  assert.equal((await f.post('/api/connect/youtube', randomBytes(32).toString('base64url'))).status, 401);
  assert.equal((await f.post('/api/connect/x', token)).status, 503);
});

test('popup handshake binds initiating browser then discovers multiple channels without token exposure', async (t) => {
  const f = await fixture(t);
  const first = await f.session();
  const second = await f.session();
  const flow = await f.connect(first);
  const start = await f.request(flow.path);
  const html = await start.text();
  assert.equal(start.status, 200);
  assert.match(start.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(html, /emc-oauth-ready/);
  assert.match(html, /event\.source!==window\.opener/);
  assert.equal(html.includes(first), false);
  const binding = await f.bind(first, flow.state);
  assert.match(binding.cookie, /^__Secure-emc_oauth_/);
  const authorization = new URL(binding.authorizationUrl);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorization.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authorization.searchParams.get('state'), flow.state);
  const result = await f.callback(flow.state, binding.cookie);
  assert.equal(result.status, 200);
  const callbackHtml = await result.text();
  assert.match(callbackHtml, /"ok":true/);
  assert.equal(callbackHtml.includes('private-'), false);
  assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  const connected = await f.channels(first);
  assert.equal(connected.channels.length, 2);
  assert.equal(connected.channels[0].platform, 'YouTube');
  assert.equal(JSON.stringify(connected).includes('private-'), false);
  assert.equal(connected.channels.some((item) => 'tokens' in item), false);
  assert.equal((await f.channels(second)).channels.length, 0);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].options.body, /code_verifier=/);
});

test('shared authorization links cannot attach victim accounts without initiating browser binding', async (t) => {
  const f = await fixture(t);
  const attacker = await f.session();
  const victim = await f.session();
  const flow = await f.connect(attacker);
  const wrongSession = await f.post('/api/oauth/bind', victim, { state: flow.state }, publicBackend);
  assert.equal(wrongSession.status, 400);
  assert.equal((await f.post('/api/oauth/bind', attacker, { state: flow.state }, frontend)).status, 403);
  const response = await f.callback(flow.state, null);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /browser_binding_failed/);
  assert.equal(f.calls.length, 0);
  const binding = await f.bind(attacker, flow.state);
  assert.equal((await f.callback(flow.state, `${binding.cookie}wrong`)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('OAuth state is single use and exact provider binding rejects replay', async (t) => {
  const f = await fixture(t);
  const token = await f.session();
  const flow = await f.connect(token);
  const binding = await f.bind(token, flow.state);
  const wrongProvider = await f.callback(flow.state, binding.cookie, 'code=demo-code', 'x');
  assert.equal(wrongProvider.status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.callback(flow.state, binding.cookie)).status, 200);
  const replay = await f.callback(flow.state, binding.cookie);
  assert.equal(replay.status, 400);
  assert.match(await replay.text(), /invalid_oauth_state/);
  assert.equal(f.calls.length, 2);
});

test('OAuth cancellation consumes state without provider requests and exposes safe message only', async (t) => {
  const f = await fixture(t);
  const token = await f.session();
  const flow = await f.connect(token);
  const binding = await f.bind(token, flow.state);
  const result = await f.callback(flow.state, binding.cookie, 'error=access_denied&error_description=private-secret');
  const html = await result.text();
  assert.equal(result.status, 400);
  assert.match(html, /authorization_cancelled/);
  assert.equal(html.includes('private-secret'), false);
  assert.equal(f.calls.length, 0);
  assert.match(await (await f.callback(flow.state, binding.cookie)).text(), /invalid_oauth_state/);
});

test('OAuth states expire after ten minutes and duplicate state is rejected', async (t) => {
  let timestamp = Date.now();
  const f = await fixture(t, { now: () => timestamp });
  const token = await f.session();
  const flow = await f.connect(token);
  const binding = await f.bind(token, flow.state);
  const duplicate = await f.request(`/oauth/youtube/callback?state=${flow.state}&state=${flow.state}&code=demo`, { headers: { Cookie: binding.cookie } });
  assert.equal(duplicate.status, 400);
  timestamp += 11 * 60 * 1000;
  const expired = await f.callback(flow.state, binding.cookie);
  assert.equal(expired.status, 400);
  assert.match(await expired.text(), /invalid_oauth_state/);
  assert.equal(f.calls.length, 0);
});

test('discovery failure creates no misleading connected account and hides provider error contents', async (t) => {
  const f = await fixture(t, { providerFetch: async (url) => String(url).includes('/token') ? Response.json({ access_token: 'private-token', token_type: 'Bearer' }) : Response.json({ error: { message: 'private-sensitive-provider-debug' } }, { status: 403 }) });
  const token = await f.session();
  const flow = await f.connect(token);
  const binding = await f.bind(token, flow.state);
  const response = await f.callback(flow.state, binding.cookie);
  const html = await response.text();
  assert.equal(response.status, 400);
  assert.match(html, /provider_account_discovery_failed/);
  assert.equal(html.includes('private-'), false);
  assert.equal((await f.channels(token)).channels.length, 0);
});

test('missing provider accounts return explicit failure rather than fake connection', async (t) => {
  const f = await fixture(t, { providerFetch: async (url) => String(url).includes('/token') ? Response.json({ access_token: 'access-token', token_type: 'Bearer' }) : Response.json({ items: [] }) });
  const token = await f.session();
  const flow = await f.connect(token);
  const binding = await f.bind(token, flow.state);
  const response = await f.callback(flow.state, binding.cookie);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /provider_no_accounts/);
  assert.equal((await f.channels(token)).channels.length, 0);
});

test('disconnect removes only session-owned channel and accurately reports no provider revocation', async (t) => {
  const f = await fixture(t);
  const first = await f.session();
  const second = await f.session();
  const flow = await f.connect(first);
  const binding = await f.bind(first, flow.state);
  await f.callback(flow.state, binding.cookie);
  const id = (await f.channels(first)).channels[0].id;
  const remove = (token) => f.request(`/api/channels/${id}`, { method: 'DELETE', headers: { Origin: frontend, Authorization: `Bearer ${token}` } });
  assert.equal((await remove(second)).status, 404);
  const result = await remove(first);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { removed: true, revoked: false });
  assert.equal((await f.channels(first)).channels.length, 1);
});

test('payload and mutation rate limits reject excessive requests', async (t) => {
  const f = await fixture(t);
  const token = await f.session();
  const excessive = await f.post('/api/connect/youtube', token, { value: 'x'.repeat(5000) });
  assert.equal(excessive.status, 413);
  let result;
  for (let count = 0; count < 31; count += 1) result = await f.post('/api/connect/youtube', token);
  assert.equal(result.status, 429);
});
