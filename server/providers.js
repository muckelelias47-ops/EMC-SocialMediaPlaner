// OAuth adapters run exclusively on the server. Tokens must never be sent to the PWA.
export const PROVIDERS = Object.freeze([
  { id: 'meta', name: 'Facebook und Instagram', platforms: ['Facebook', 'Instagram'], scopes: ['pages_show_list', 'pages_read_engagement', 'instagram_basic'], clientIdEnv: 'META_APP_ID', clientSecretEnv: 'META_APP_SECRET', usesPkce: false },
  { id: 'tiktok', name: 'TikTok', platforms: ['TikTok'], scopes: ['user.info.basic', 'user.info.profile'], clientIdEnv: 'TIKTOK_CLIENT_KEY', clientSecretEnv: 'TIKTOK_CLIENT_SECRET', usesPkce: false },
  { id: 'linkedin', name: 'LinkedIn', platforms: ['LinkedIn'], scopes: ['openid', 'profile'], clientIdEnv: 'LINKEDIN_CLIENT_ID', clientSecretEnv: 'LINKEDIN_CLIENT_SECRET', usesPkce: false },
  { id: 'youtube', name: 'YouTube', platforms: ['YouTube'], scopes: ['https://www.googleapis.com/auth/youtube.readonly'], clientIdEnv: 'GOOGLE_CLIENT_ID', clientSecretEnv: 'GOOGLE_CLIENT_SECRET', usesPkce: true },
  { id: 'pinterest', name: 'Pinterest', platforms: ['Pinterest'], scopes: ['user_accounts:read'], clientIdEnv: 'PINTEREST_CLIENT_ID', clientSecretEnv: 'PINTEREST_CLIENT_SECRET', usesPkce: false },
  { id: 'x', name: 'X', platforms: ['X'], scopes: ['users.read', 'tweet.read', 'offline.access'], clientIdEnv: 'X_CLIENT_ID', clientSecretEnv: 'X_CLIENT_SECRET', usesPkce: true },
].map((provider) => Object.freeze({ ...provider, platforms: Object.freeze(provider.platforms), scopes: Object.freeze(provider.scopes) })));

const MAX_CHANNELS = 1000;
const MAX_PAGES = 10;

export function getProviderConfig(id, env = process.env) {
  const provider = PROVIDERS.find((entry) => entry.id === id);
  if (!provider) return null;
  const configuredValue = (name) => typeof env[name] === 'string' && env[name].length <= 16384 ? env[name].trim() : '';
  return {
    ...provider,
    clientId: configuredValue(provider.clientIdEnv),
    clientSecret: configuredValue(provider.clientSecretEnv),
    ...(id === 'meta' ? { graphVersion: /^v\d{1,2}\.\d+$/.test(env.META_GRAPH_VERSION || '') ? env.META_GRAPH_VERSION : 'v23.0' } : {}),
  };
}

function fail(code) {
  const error = new Error(code === 'provider_auth_failed' ? 'Die Anmeldung beim Anbieter konnte nicht abgeschlossen werden.' : 'Die Konten konnten beim Anbieter nicht abgerufen werden.');
  error.code = code;
  return error;
}

function metaRoot(config) {
  return `https://graph.facebook.com/${config.graphVersion || 'v23.0'}`;
}

export function buildAuthorizationUrl(config, { state, redirectUri, codeChallenge }) {
  if (!config?.clientId || typeof state !== 'string' || !state || state.length > 1024) throw fail('provider_auth_failed');
  let redirect;
  try { redirect = new URL(redirectUri); } catch { throw fail('provider_auth_failed'); }
  if (!['https:', 'http:'].includes(redirect.protocol) || redirect.username || redirect.password) throw fail('provider_auth_failed');
  const endpoints = {
    meta: `https://www.facebook.com/${config.graphVersion || 'v23.0'}/dialog/oauth`,
    tiktok: 'https://www.tiktok.com/v2/auth/authorize/',
    linkedin: 'https://www.linkedin.com/oauth/v2/authorization',
    youtube: 'https://accounts.google.com/o/oauth2/v2/auth',
    pinterest: 'https://www.pinterest.com/oauth/',
    x: 'https://x.com/i/oauth2/authorize',
  };
  if (!endpoints[config.id]) throw fail('provider_auth_failed');
  const url = new URL(endpoints[config.id]);
  url.searchParams.set(config.id === 'tiktok' ? 'client_key' : 'client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', config.scopes.join(['meta', 'tiktok', 'pinterest'].includes(config.id) ? ',' : ' '));
  if (config.usesPkce) {
    if (typeof codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw fail('provider_auth_failed');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (config.id === 'youtube') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent select_account');
  }
  if (config.id === 'meta') url.searchParams.set('auth_type', 'rerequest');
  return url.href;
}

// Errors from providers can contain authorization codes or tokens. Discard them.
async function requestJson(fetchImplementation, url, options, code) {
  try {
    const response = await fetchImplementation(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw fail(code);
    let body;
    if (typeof response.text === 'function') {
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw fail(code);
      body = JSON.parse(text);
    } else {
      body = await response.json();
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(code);
    return body;
  } catch {
    throw fail(code);
  }
}

function tokenValue(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\u0000-\u0020\u007f]/.test(value) ? value : null;
}

function normalizeTokens(body) {
  const accessToken = tokenValue(body.access_token);
  if (!accessToken || (body.error && body.error !== 'ok')) throw fail('provider_auth_failed');
  const tokens = { accessToken, tokenType: 'Bearer' };
  if (body.token_type && (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')) throw fail('provider_auth_failed');
  if (body.refresh_token != null) {
    const refreshToken = tokenValue(body.refresh_token);
    if (!refreshToken) throw fail('provider_auth_failed');
    tokens.refreshToken = refreshToken;
  }
  if (body.expires_in != null) {
    const expiresIn = Number(body.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn < 0 || expiresIn > 10 * 365 * 24 * 60 * 60) throw fail('provider_auth_failed');
    tokens.expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  }
  if (typeof body.scope === 'string' && body.scope.length <= 4096) tokens.scopes = body.scope.split(/[ ,]+/).filter(Boolean);
  return tokens;
}

export async function exchangeAuthorizationCode(config, { code, redirectUri, codeVerifier, fetch: fetchImplementation = globalThis.fetch }) {
  if (!config?.clientId || !config.clientSecret || typeof code !== 'string' || !code || code.length > 8192) throw fail('provider_auth_failed');
  const endpoints = {
    meta: `${metaRoot(config)}/oauth/access_token`,
    tiktok: 'https://open.tiktokapis.com/v2/oauth/token/',
    linkedin: 'https://www.linkedin.com/oauth/v2/accessToken',
    youtube: 'https://oauth2.googleapis.com/token',
    pinterest: 'https://api.pinterest.com/v5/oauth/token',
    x: 'https://api.x.com/2/oauth2/token',
  };
  if (!endpoints[config.id]) throw fail('provider_auth_failed');
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (['pinterest', 'x'].includes(config.id)) {
    // RFC 6749 section 2.3.1 requires form encoding credentials before Basic encoding.
    const encode = (value) => new URLSearchParams({ value }).toString().slice(6);
    headers.Authorization = `Basic ${Buffer.from(`${encode(config.clientId)}:${encode(config.clientSecret)}`).toString('base64')}`;
    if (config.id === 'x') form.set('client_id', config.clientId);
  } else {
    form.set(config.id === 'tiktok' ? 'client_key' : 'client_id', config.clientId);
    form.set('client_secret', config.clientSecret);
  }
  if (config.usesPkce) {
    if (typeof codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw fail('provider_auth_failed');
    form.set('code_verifier', codeVerifier);
  }
  const body = await requestJson(fetchImplementation, endpoints[config.id], { method: 'POST', headers, body: form.toString() }, 'provider_auth_failed');
  return normalizeTokens(body);
}

function textValue(value, maxLength = 256) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength) : '';
}

function accountId(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !id || id.length > 256 || /[\u0000-\u0020\u007f]/.test(id)) throw fail('provider_account_discovery_failed');
  return id;
}

function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    const sensitive = ['access_token', 'refresh_token', 'client_secret', 'id_token', 'authorization', 'code'];
    if (sensitive.some((field) => url.searchParams.has(field)) || /(?:^|[&#])(access_token|refresh_token|id_token)=/i.test(url.hash)) return '';
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function channel(config, platform, id, name, tokens, { handle, url } = {}) {
  const normalized = { provider: config.id, platform, accountId: accountId(id), name: textValue(name, 160), tokens: { ...tokens } };
  if (!normalized.name) throw fail('provider_account_discovery_failed');
  const cleanHandle = textValue(handle, 100);
  const cleanUrl = publicUrl(url);
  if (cleanHandle) normalized.handle = cleanHandle;
  if (cleanUrl) normalized.url = cleanUrl;
  return normalized;
}

export async function discoverChannels(config, tokens, { fetch: fetchImplementation = globalThis.fetch } = {}) {
  if (!config || !tokenValue(tokens?.accessToken)) throw fail('provider_account_discovery_failed');
  const get = (url, accessToken = tokens.accessToken) => requestJson(fetchImplementation, url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }, 'provider_account_discovery_failed');
  try {
    if (config.id === 'meta') {
      const channels = [];
      const seen = new Set();
      let cursor = '';
      for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
        const url = new URL(`${metaRoot(config)}/me/accounts`);
        url.searchParams.set('fields', 'id,name,link,access_token,instagram_business_account{id,username,name}');
        url.searchParams.set('limit', '100');
        if (cursor) url.searchParams.set('after', cursor);
        const body = await get(url.href);
        if (body.error || !Array.isArray(body.data) || body.data.length > 100) throw fail('provider_account_discovery_failed');
        for (const page of body.data) {
          const id = accountId(page?.id);
          if (seen.has(id)) continue;
          seen.add(id);
          const accessToken = tokenValue(page.access_token);
          if (!accessToken) throw fail('provider_account_discovery_failed');
          // Facebook Page and linked Instagram accounts use the Page token, not the user token.
          const pageTokens = { accessToken, tokenType: 'Bearer', ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}) };
          channels.push(channel(config, 'Facebook', id, page.name, pageTokens, { url: publicUrl(page.link) || `https://www.facebook.com/${encodeURIComponent(id)}` }));
          const instagram = page.instagram_business_account;
          if (instagram) {
            const handle = textValue(instagram.username, 100);
            channels.push(channel(config, 'Instagram', instagram.id, instagram.name || handle, pageTokens, { handle, url: /^[A-Za-z0-9._]+$/.test(handle) ? `https://www.instagram.com/${encodeURIComponent(handle)}/` : '' }));
          }
          if (channels.length > MAX_CHANNELS) throw fail('provider_account_discovery_failed');
        }
        if (!body.paging?.next) return channels;
        const nextCursor = body.paging?.cursors?.after;
        if (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 4096 || nextCursor === cursor) throw fail('provider_account_discovery_failed');
        cursor = nextCursor;
      }
      throw fail('provider_account_discovery_failed');
    }
    if (config.id === 'tiktok') {
      const body = await get('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username,profile_deep_link');
      if ((body.error?.code && body.error.code !== 'ok') || !body.data?.user) throw fail('provider_account_discovery_failed');
      const user = body.data.user;
      return [channel(config, 'TikTok', user.open_id, user.display_name, tokens, { handle: user.username, url: user.profile_deep_link })];
    }
    if (config.id === 'linkedin') {
      const user = await get('https://api.linkedin.com/v2/userinfo');
      if (user.error) throw fail('provider_account_discovery_failed');
      return [channel(config, 'LinkedIn', user.sub, user.name || [user.given_name, user.family_name].filter((value) => typeof value === 'string').join(' '), tokens)];
    }
    if (config.id === 'youtube') {
      const channels = [];
      const seen = new Set();
      let cursor = '';
      for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
        const url = new URL('https://www.googleapis.com/youtube/v3/channels');
        url.searchParams.set('part', 'snippet');
        url.searchParams.set('mine', 'true');
        url.searchParams.set('maxResults', '50');
        if (cursor) url.searchParams.set('pageToken', cursor);
        const body = await get(url.href);
        if (body.error || !Array.isArray(body.items) || body.items.length > 50) throw fail('provider_account_discovery_failed');
        for (const item of body.items) {
          const id = accountId(item?.id);
          if (seen.has(id)) continue;
          seen.add(id);
          channels.push(channel(config, 'YouTube', id, item.snippet?.title, tokens, { handle: item.snippet?.customUrl, url: `https://www.youtube.com/channel/${encodeURIComponent(id)}` }));
        }
        if (!body.nextPageToken) return channels;
        if (typeof body.nextPageToken !== 'string' || body.nextPageToken.length > 4096 || body.nextPageToken === cursor) throw fail('provider_account_discovery_failed');
        cursor = body.nextPageToken;
      }
      throw fail('provider_account_discovery_failed');
    }
    if (config.id === 'pinterest') {
      const user = await get('https://api.pinterest.com/v5/user_account');
      if (user.error || !textValue(user.username)) throw fail('provider_account_discovery_failed');
      const username = textValue(user.username, 100);
      // Pinterest v5 user_account returns username, but no numeric account ID for all account types.
      return [channel(config, 'Pinterest', user.id || username, user.business_name || username, tokens, { handle: username, url: `https://www.pinterest.com/${encodeURIComponent(username)}/` })];
    }
    if (config.id === 'x') {
      const body = await get('https://api.x.com/2/users/me');
      if (body.error || body.errors || !body.data) throw fail('provider_account_discovery_failed');
      const user = body.data;
      const username = textValue(user.username, 100);
      return [channel(config, 'X', user.id, user.name, tokens, { handle: username, url: username ? `https://x.com/${encodeURIComponent(username)}` : '' })];
    }
    throw fail('provider_account_discovery_failed');
  } catch {
    throw fail('provider_account_discovery_failed');
  }
}
