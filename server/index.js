import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EncryptedStore, readEncryptionKey } from './store.js';
import { PROVIDERS, getProviderConfig, buildAuthorizationUrl, exchangeAuthorizationCode, discoverChannels } from './providers.js';

const STATE_DURATION_MS = 10 * 60 * 1000;
const errors = new Set(['provider_auth_failed', 'provider_account_discovery_failed', 'provider_no_accounts', 'authorization_cancelled', 'invalid_oauth_state', 'session_expired', 'storage_failed']);

function validOrigin(value) {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

async function readBody(request) {
  const contentType = String(request.headers['content-type'] || '').split(';')[0].trim();
  if (contentType && contentType !== 'application/json') throw Object.assign(new Error('Unsupported content type.'), { status: 415 });
  if (Number(request.headers['content-length']) > 4096) throw Object.assign(new Error('Request body too large.'), { status: 413 });
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 4096) throw Object.assign(new Error('Request body too large.'), { status: 413 });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

export async function createHandler({ env = process.env, fetch: providerFetch = globalThis.fetch, store: suppliedStore, now = Date.now } = {}) {
  const publicBaseUrl = validOrigin(env.PUBLIC_BASE_URL);
  const frontendOrigin = validOrigin(env.FRONTEND_ORIGIN);
  const key = readEncryptionKey(env.CHANNEL_ENCRYPTION_KEY);
  const dataDirectory = env.DATA_DIR || resolve('..', '.emc-channel-data');
  const store = suppliedStore || (key ? await new EncryptedStore({ directory: dataDirectory, key, now }).init() : null);
  const pending = new Map();
  const rateLimits = new Map();
  const providerConfigs = new Map(PROVIDERS.map((provider) => [provider.id, getProviderConfig(provider.id, env)]));

  function providerStatus(provider) {
    const config = providerConfigs.get(provider.id);
    const missingConfiguration = [];
    if (!config?.clientId) missingConfiguration.push(provider.clientIdEnv);
    if (!config?.clientSecret) missingConfiguration.push(provider.clientSecretEnv);
    if (!publicBaseUrl) missingConfiguration.push('PUBLIC_BASE_URL');
    if (!frontendOrigin) missingConfiguration.push('FRONTEND_ORIGIN');
    if (!key && !suppliedStore) missingConfiguration.push('CHANNEL_ENCRYPTION_KEY');
    return { id: provider.id, name: provider.name, platforms: provider.platforms, scopes: provider.scopes, configured: Boolean(config?.clientId && config?.clientSecret), authorizationReady: missingConfiguration.length === 0 && Boolean(store), missingConfiguration };
  }

  function prune() {
    const timestamp = now();
    for (const [state, details] of pending) if (details.expiresAt <= timestamp) pending.delete(state);
    for (const [ip, details] of rateLimits) if (details.expiresAt <= timestamp) rateLimits.delete(ip);
  }

  function allowedRate(request, bucket, max, duration) {
    prune();
    const ip = request.socket.remoteAddress || 'unknown';
    const identity = `${bucket}:${ip}`;
    let entry = rateLimits.get(identity);
    if (!entry) {
      if (rateLimits.size >= 10000) return false;
      entry = { count: 0, expiresAt: now() + duration };
      rateLimits.set(identity, entry);
    }
    entry.count += 1;
    return entry.count <= max;
  }

  function bearer(request) {
    const value = request.headers.authorization;
    return typeof value === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(value) ? value.slice(7) : null;
  }

  async function timedFetch(url, options = {}) {
    // Node's TLS verification stays enabled. The deployment may set NODE_USE_ENV_PROXY=1.
    return providerFetch(url, { ...options, signal: AbortSignal.timeout(20000), redirect: 'error' });
  }

  const handler = async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    const json = (status, body) => {
      if (response.writableEnded) return;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const popup = (provider, ok, error) => {
      const nonce = randomBytes(16).toString('base64');
      const payload = { type: 'emc-oauth', provider, ok, ...(error ? { error } : {}) };
      const message = ok ? 'Deine Kanäle wurden verbunden. Du kannst dieses Fenster schließen.' : 'Die Verbindung wurde nicht hergestellt. Schließe dieses Fenster und versuche es in der App erneut.';
      response.writeHead(ok ? 200 : 400, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      });
      response.end(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EMC Kontoverbindung</title><body><p>${htmlEscape(message)}</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${safeJson(payload)},${safeJson(frontendOrigin)});if(${ok ? 'true' : 'false'})window.close();}</script></body></html>`);
    };
    try {
      if ((request.url || '').length > 8192) return json(414, { error: 'request_too_large' });
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      const method = request.method;
      const isApi = path.startsWith('/api/');
      const origin = request.headers.origin;
      const bindRequest = path === '/api/oauth/bind';
      const allowedOrigin = bindRequest ? publicBaseUrl : frontendOrigin;
      if (isApi) {
        response.setHeader('Vary', 'Origin');
        if (origin && origin !== allowedOrigin) return json(403, { error: 'origin_not_allowed' });
        if (origin === allowedOrigin && allowedOrigin) response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        if (method === 'OPTIONS') {
          if (!allowedOrigin || origin !== allowedOrigin) return json(403, { error: 'origin_not_allowed' });
          response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
          return response.end();
        }
        if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(method) && (!allowedOrigin || origin !== allowedOrigin)) return json(403, { error: 'origin_not_allowed' });
      }
      if (path === '/health' && method === 'GET') return json(200, { ok: true });
      if (path === '/api/config' && method === 'GET') return json(200, { providers: PROVIDERS.map(providerStatus), callbackBaseUrl: publicBaseUrl, frontendOrigin, sessionReady: Boolean(store && publicBaseUrl && frontendOrigin) });
      if (path === '/api/session' && method === 'POST') {
        if (!store || !publicBaseUrl || !frontendOrigin) return json(503, { error: 'backend_not_configured' });
        if (!allowedRate(request, 'sessions', 60, 60 * 60 * 1000)) return json(429, { error: 'rate_limit_exceeded' });
        await readBody(request);
        return json(201, await store.createSession());
      }
      if (path === '/api/channels' && method === 'GET') {
        const result = store?.listChannels(bearer(request));
        return result ? json(200, result) : json(401, { error: 'session_expired' });
      }
      const removeMatch = path.match(/^\/api\/channels\/([a-f0-9]{32})$/);
      if (removeMatch && method === 'DELETE') {
        const token = bearer(request);
        if (!store?.getSession(token)) return json(401, { error: 'session_expired' });
        if (!allowedRate(request, 'mutations', 120, 60 * 1000)) return json(429, { error: 'rate_limit_exceeded' });
        const removed = await store.removeChannel(token, removeMatch[1]);
        return removed ? json(200, { removed: true, revoked: false }) : json(404, { error: 'channel_not_found' });
      }
      const connectMatch = path.match(/^\/api\/connect\/([a-z]+)$/);
      if (connectMatch && method === 'POST') {
        const token = bearer(request);
        if (!store?.getSession(token)) return json(401, { error: 'session_expired' });
        const provider = PROVIDERS.find((item) => item.id === connectMatch[1]);
        if (!provider) return json(404, { error: 'provider_not_found' });
        if (!providerStatus(provider).authorizationReady) return json(503, { error: 'provider_not_configured' });
        if (!allowedRate(request, 'oauth', 30, 60 * 1000) || pending.size >= 10000) return json(429, { error: 'rate_limit_exceeded' });
        await readBody(request);
        const config = providerConfigs.get(provider.id);
        const state = randomBytes(32).toString('base64url');
        const codeVerifier = config.usesPkce ? randomBytes(32).toString('base64url') : undefined;
        const codeChallenge = codeVerifier ? createHash('sha256').update(codeVerifier).digest('base64url') : undefined;
        const redirectUri = `${publicBaseUrl}/oauth/${provider.id}/callback`;
        const authorizationUrl = buildAuthorizationUrl(config, { state, redirectUri, codeChallenge });
        pending.set(state, { provider: provider.id, token, expiresAt: now() + STATE_DURATION_MS, redirectUri, codeVerifier, authorizationUrl });
        return json(200, { authorizationUrl: `${publicBaseUrl}/oauth/${provider.id}/start?state=${encodeURIComponent(state)}` });
      }
      if (path === '/api/oauth/bind' && method === 'POST') {
        if (!allowedRate(request, 'bind', 60, 60 * 1000)) return json(429, { error: 'rate_limit_exceeded' });
        const token = bearer(request);
        if (!store?.getSession(token)) return json(401, { error: 'session_expired' });
        const body = await readBody(request);
        const state = typeof body.state === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.state) ? body.state : null;
        const details = state ? pending.get(state) : null;
        if (!details || details.token !== token || details.expiresAt <= now()) return json(400, { error: 'invalid_oauth_state' });
        const browserNonce = randomBytes(32).toString('base64url');
        details.browserNonceHash = createHash('sha256').update(browserNonce).digest('hex');
        const cookieName = `${publicBaseUrl.startsWith('https:') ? '__Secure-' : ''}emc_oauth_${state.slice(0, 16)}`;
        const secure = publicBaseUrl.startsWith('https:') ? '; Secure' : '';
        response.setHeader('Set-Cookie', `${cookieName}=${browserNonce}; Path=/oauth/${details.provider}/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
        return json(200, { authorizationUrl: details.authorizationUrl });
      }
      const startMatch = path.match(/^\/oauth\/([a-z]+)\/start$/);
      if (startMatch && method === 'GET') {
        const provider = startMatch[1];
        const states = url.searchParams.getAll('state');
        const state = states.length === 1 ? states[0] : null;
        const details = state ? pending.get(state) : null;
        if (!details || details.provider !== provider || details.expiresAt <= now() || !frontendOrigin) return json(400, { error: 'invalid_oauth_state' });
        const nonce = randomBytes(16).toString('base64');
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
        });
        const script = `const frontend=${safeJson(frontendOrigin)};const state=${safeJson(state)};const provider=${safeJson(provider)};let started=false;window.addEventListener('message',async(event)=>{if(started||event.source!==window.opener||event.origin!==frontend||event.data?.type!=='emc-oauth-bind')return;started=true;try{const result=await fetch('/api/oauth/bind',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+event.data.sessionToken},body:JSON.stringify({state})});const body=await result.json();if(!result.ok)throw new Error();window.location.replace(body.authorizationUrl);}catch{document.getElementById('status').textContent='Die Anmeldung konnte nicht gestartet werden. Schließe dieses Fenster und versuche es erneut.';window.opener?.postMessage({type:'emc-oauth',provider,ok:false,error:'browser_binding_failed'},frontend);}});if(window.opener)window.opener.postMessage({type:'emc-oauth-ready',provider},frontend);else document.getElementById('status').textContent='Bitte starte die Anmeldung direkt aus der EMC-App.';`;
        return response.end(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EMC Anmeldung starten</title><body><p id="status">Die sichere Anmeldung wird vorbereitet.</p><script nonce="${nonce}">${script}</script></body></html>`);
      }
      const callbackMatch = path.match(/^\/oauth\/([a-z]+)\/callback$/);
      if (callbackMatch && method === 'GET') {
        const provider = callbackMatch[1];
        if (!frontendOrigin) return json(503, { error: 'backend_not_configured' });
        if (!allowedRate(request, 'callbacks', 120, 60 * 1000)) return json(429, { error: 'rate_limit_exceeded' });
        const states = url.searchParams.getAll('state');
        const state = states.length === 1 ? states[0] : null;
        const details = state ? pending.get(state) : null;
        if (!details || details.provider !== provider || details.expiresAt <= now()) return popup(provider, false, 'invalid_oauth_state');
        const cookieName = `${publicBaseUrl.startsWith('https:') ? '__Secure-' : ''}emc_oauth_${state.slice(0, 16)}`;
        const cookies = String(request.headers.cookie || '').split(';').map((part) => part.trim());
        const browserNonce = cookies.find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
        if (!browserNonce || !/^[A-Za-z0-9_-]{43}$/.test(browserNonce) || createHash('sha256').update(browserNonce).digest('hex') !== details.browserNonceHash) return popup(provider, false, 'browser_binding_failed');
        pending.delete(state);
        const secure = publicBaseUrl.startsWith('https:') ? '; Secure' : '';
        response.setHeader('Set-Cookie', `${cookieName}=; Path=/oauth/${provider}/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
        if (!store?.getSession(details.token)) return popup(provider, false, 'session_expired');
        if (url.searchParams.has('error')) return popup(provider, false, 'authorization_cancelled');
        const codes = url.searchParams.getAll('code');
        if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) return popup(provider, false, 'provider_auth_failed');
        try {
          const config = providerConfigs.get(provider);
          const tokens = await exchangeAuthorizationCode(config, { code: codes[0], redirectUri: details.redirectUri, codeVerifier: details.codeVerifier, fetch: timedFetch });
          const channels = await discoverChannels(config, tokens, { fetch: timedFetch });
          if (!channels.length) return popup(provider, false, 'provider_no_accounts');
          await store.addChannels(details.token, channels);
          return popup(provider, true);
        } catch (error) {
          const code = errors.has(error.code) ? error.code : 'provider_auth_failed';
          return popup(provider, false, code);
        }
      }
      return json(404, { error: 'not_found' });
    } catch (error) {
      if (!response.writableEnded && !response.headersSent) return json(error.status || 500, { error: error.status ? 'invalid_request' : 'server_error' });
      response.end();
    }
  };
  handler.store = store;
  return handler;
}

export async function startServer({ env = process.env, ...options } = {}) {
  const handler = await createHandler({ env, ...options });
  const server = createServer(handler);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 30;
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT.');
  await new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, env.HOST || '0.0.0.0', resolveStart);
  });
  return { server, port: server.address().port, close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer().then(({ port }) => console.log(`EMC channel API listening on port ${port}`)).catch(() => {
    console.error('EMC channel API could not start. Check deployment configuration and encrypted storage.');
    process.exitCode = 1;
  });
}
