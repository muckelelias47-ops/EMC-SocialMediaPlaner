import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PROVIDERS, getProviderConfig, buildAuthorizationUrl, exchangeAuthorizationCode, discoverChannels } from './providers.js';

const redirectUri = 'https://planner.example.test/api/oauth/callback';
const codeVerifier = 'oauth-code-verifier-with-43-or-more-safe-characters';
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
const userToken = 'user-access-token-not-for-the-browser';
const pageToken = 'page-access-token-not-for-the-browser';
const refreshToken = 'refresh-token-not-for-the-browser';
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function configuredProvider(id) {
  const descriptor = PROVIDERS.find((provider) => provider.id === id);
  return getProviderConfig(id, { [descriptor.clientIdEnv]: 'test-client-id', [descriptor.clientSecretEnv]: 'test-client-secret' });
}

function safeError(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.doesNotMatch(String(error), /sensitive-provider-message|user-access-token|test-client-secret/);
    assert.equal(error.cause, undefined);
    return true;
  };
}

const fixtures = [
  {
    id: 'meta', authorizationOrigin: 'https://www.facebook.com', tokenEndpoint: 'https://graph.facebook.com/v23.0/oauth/access_token', discoveryOrigin: 'https://graph.facebook.com',
    scopes: 'pages_show_list,pages_read_engagement,instagram_basic',
    accountResponse: { data: [{ id: 'facebook-page-123', name: 'EMC Facebook', access_token: pageToken, instagram_business_account: { id: 'instagram-456', username: 'emc.business', name: 'EMC Instagram' } }] },
    expected: [{ platform: 'Facebook', accountId: 'facebook-page-123', name: 'EMC Facebook' }, { platform: 'Instagram', accountId: 'instagram-456', name: 'EMC Instagram', handle: 'emc.business' }],
  },
  {
    id: 'tiktok', authorizationOrigin: 'https://www.tiktok.com', tokenEndpoint: 'https://open.tiktokapis.com/v2/oauth/token/', discoveryOrigin: 'https://open.tiktokapis.com',
    scopes: 'user.info.basic,user.info.profile',
    accountResponse: { data: { user: { open_id: 'tiktok-123', display_name: 'EMC TikTok', username: 'emc.tiktok', profile_deep_link: 'https://www.tiktok.com/@emc.tiktok' } }, error: { code: 'ok' } },
    expected: [{ platform: 'TikTok', accountId: 'tiktok-123', name: 'EMC TikTok', handle: 'emc.tiktok' }],
  },
  {
    id: 'linkedin', authorizationOrigin: 'https://www.linkedin.com', tokenEndpoint: 'https://www.linkedin.com/oauth/v2/accessToken', discoveryOrigin: 'https://api.linkedin.com',
    scopes: 'openid profile', accountResponse: { sub: 'linkedin-123', name: 'EMC LinkedIn' },
    expected: [{ platform: 'LinkedIn', accountId: 'linkedin-123', name: 'EMC LinkedIn' }],
  },
  {
    id: 'youtube', authorizationOrigin: 'https://accounts.google.com', tokenEndpoint: 'https://oauth2.googleapis.com/token', discoveryOrigin: 'https://www.googleapis.com',
    scopes: 'https://www.googleapis.com/auth/youtube.readonly', accountResponse: { items: [{ id: 'UC123', snippet: { title: 'EMC YouTube', customUrl: '@emc.youtube' } }] },
    expected: [{ platform: 'YouTube', accountId: 'UC123', name: 'EMC YouTube', handle: '@emc.youtube' }],
  },
  {
    id: 'pinterest', authorizationOrigin: 'https://www.pinterest.com', tokenEndpoint: 'https://api.pinterest.com/v5/oauth/token', discoveryOrigin: 'https://api.pinterest.com',
    scopes: 'user_accounts:read', accountResponse: { username: 'emc-pinterest', business_name: 'EMC Pinterest' },
    expected: [{ platform: 'Pinterest', accountId: 'emc-pinterest', name: 'EMC Pinterest', handle: 'emc-pinterest' }],
  },
  {
    id: 'x', authorizationOrigin: 'https://x.com', tokenEndpoint: 'https://api.x.com/2/oauth2/token', discoveryOrigin: 'https://api.x.com',
    scopes: 'users.read tweet.read offline.access', accountResponse: { data: { id: 'x-123', name: 'EMC X', username: 'emc_x' } },
    expected: [{ platform: 'X', accountId: 'x-123', name: 'EMC X', handle: 'emc_x' }],
  },
];

for (const fixture of fixtures) {
  test(`${fixture.id}: authorization, server-only token exchange and authenticated account discovery`, async () => {
    const config = configuredProvider(fixture.id);
    const authorization = new URL(buildAuthorizationUrl(config, { state: 'oauth-state-for-this-session', redirectUri, codeChallenge }));
    assert.equal(authorization.origin, fixture.authorizationOrigin);
    assert.equal(authorization.searchParams.get('response_type'), 'code');
    assert.equal(authorization.searchParams.get('state'), 'oauth-state-for-this-session');
    assert.equal(authorization.searchParams.get('redirect_uri'), redirectUri);
    assert.equal(authorization.searchParams.get('scope'), fixture.scopes);
    assert.equal(authorization.searchParams.get(fixture.id === 'tiktok' ? 'client_key' : 'client_id'), 'test-client-id');
    assert.doesNotMatch(authorization.href, /test-client-secret|access_token|code_verifier/);
    if (['x', 'youtube'].includes(fixture.id)) {
      assert.equal(authorization.searchParams.get('code_challenge'), codeChallenge);
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    } else {
      assert.equal(authorization.searchParams.has('code_challenge'), false);
    }
    if (fixture.id === 'youtube') {
      assert.equal(authorization.searchParams.get('access_type'), 'offline');
      assert.equal(authorization.searchParams.get('prompt'), 'consent select_account');
    }
    let tokenRequests = 0;
    const beforeExchange = Date.now();
    const tokens = await exchangeAuthorizationCode(config, {
      code: 'one-time-authorization-code', redirectUri, codeVerifier,
      fetch: async (url, options) => {
        tokenRequests += 1;
        assert.equal(url, fixture.tokenEndpoint);
        assert.equal(options.method, 'POST');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
        const form = new URLSearchParams(options.body);
        assert.equal(form.get('code'), 'one-time-authorization-code');
        assert.equal(form.get('redirect_uri'), redirectUri);
        assert.equal(form.get('grant_type'), 'authorization_code');
        if (fixture.id === 'tiktok') {
          assert.equal(form.get('client_key'), 'test-client-id');
          assert.equal(form.has('client_id'), false);
        }
        if (['x', 'pinterest'].includes(fixture.id)) {
          assert.equal(Buffer.from(options.headers.Authorization.slice(6), 'base64').toString(), 'test-client-id:test-client-secret');
          assert.equal(form.has('client_secret'), false);
        } else {
          assert.equal(form.get('client_secret'), 'test-client-secret');
        }
        assert.equal(form.get('code_verifier'), ['x', 'youtube'].includes(fixture.id) ? codeVerifier : null);
        return jsonResponse({ access_token: userToken, refresh_token: refreshToken, token_type: 'bearer', expires_in: 3600 });
      },
    });
    assert.equal(tokenRequests, 1);
    assert.equal(tokens.accessToken, userToken);
    assert.equal(tokens.refreshToken, refreshToken);
    assert.equal(tokens.tokenType, 'Bearer');
    assert.ok(Date.parse(tokens.expiresAt) >= beforeExchange + 3600000);
    assert.ok(Date.parse(tokens.expiresAt) <= Date.now() + 3600000);
    let discoveryRequests = 0;
    const channels = await discoverChannels(config, tokens, {
      fetch: async (url, options) => {
        discoveryRequests += 1;
        assert.equal(new URL(url).origin, fixture.discoveryOrigin);
        assert.doesNotMatch(url, /user-access-token|test-client-secret/);
        assert.equal(options.headers.Authorization, `Bearer ${userToken}`);
        assert.equal(options.redirect, 'error');
        return jsonResponse(fixture.accountResponse);
      },
    });
    assert.equal(discoveryRequests, 1);
    assert.deepEqual(channels.map(({ platform, accountId, name, handle }) => ({ platform, accountId, name, ...(handle ? { handle } : {}) })), fixture.expected);
    assert.ok(channels.every((channel) => channel.provider === fixture.id));
    assert.ok(channels.every((channel) => channel.tokens.accessToken === (fixture.id === 'meta' ? pageToken : userToken)));
    if (fixture.id === 'linkedin') assert.equal(channels[0].url, undefined);
  });
}

test('Pinterest authorization serializes several scopes with the provider comma separator', () => {
  const config = { ...configuredProvider('pinterest'), scopes: ['user_accounts:read', 'boards:read'] };
  const url = new URL(buildAuthorizationUrl(config, { state: 'state', redirectUri }));
  assert.equal(url.searchParams.get('scope'), 'user_accounts:read,boards:read');
});

test('PKCE providers reject absent or malformed challenges and verifiers before any request', async () => {
  for (const id of ['x', 'youtube']) {
    const config = configuredProvider(id);
    for (const challenge of [undefined, '', 'wrong-size', '!'.repeat(43)]) {
      assert.throws(() => buildAuthorizationUrl(config, { state: 'state', redirectUri, codeChallenge: challenge }), safeError('provider_auth_failed'));
    }
    let requests = 0;
    for (const verifier of [undefined, '', 'short', '!'.repeat(43)]) {
      await assert.rejects(exchangeAuthorizationCode(config, { code: 'code', redirectUri, codeVerifier: verifier, fetch: async () => { requests += 1; } }), safeError('provider_auth_failed'));
    }
    assert.equal(requests, 0);
  }
});

test('provider configuration reads only expected credentials and validates Graph version', () => {
  assert.equal(getProviderConfig('unknown-provider'), null);
  assert.equal(getProviderConfig('meta', { META_GRAPH_VERSION: 'v24.0' }).graphVersion, 'v24.0');
  assert.equal(getProviderConfig('meta', { META_GRAPH_VERSION: '//evil.example.test' }).graphVersion, 'v23.0');
  assert.equal(getProviderConfig('youtube', { GOOGLE_CLIENT_ID: 'existing-id', GOOGLE_CLIENT_SECRET: 'existing-secret', GITHUB_TOKEN: 'must-not-be-used' }).clientId, 'existing-id');
  assert.equal(PROVIDERS.some((provider) => 'clientSecret' in provider), false);
});

test('malformed tokens and provider failures use safe errors without leaking sensitive response data', async () => {
  const config = configuredProvider('linkedin');
  const exchange = (fetch) => exchangeAuthorizationCode(config, { code: 'sensitive-provider-message', redirectUri, fetch });
  const malformed = [
    { access_token: userToken, error: 'invalid_grant', error_description: 'sensitive-provider-message' },
    { access_token: `${userToken}\nunsafe` },
    { access_token: userToken, token_type: 'mac' },
    { access_token: userToken, refresh_token: 'token with spaces' },
    { access_token: userToken, expires_in: 'not-a-number' },
    { access_token: userToken, expires_in: -1 },
    { access_token: userToken, expires_in: 1e50 },
    { error: 'sensitive-provider-message' },
    null,
    [],
  ];
  for (const body of malformed) {
    await assert.rejects(exchange(async () => jsonResponse(body)), safeError('provider_auth_failed'));
  }
  await assert.rejects(exchange(async () => jsonResponse({ error: 'sensitive-provider-message' }, 401)), safeError('provider_auth_failed'));
  await assert.rejects(exchange(async () => { throw new Error('sensitive-provider-message'); }), safeError('provider_auth_failed'));
  await assert.rejects(exchange(async () => new Response('not-json-sensitive-provider-message')), safeError('provider_auth_failed'));
  await assert.rejects(exchange(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))), safeError('provider_auth_failed'));
});

test('Meta pagination reconstructs a fixed trusted host and keeps Page tokens with their channels', async () => {
  const requests = [];
  const channels = await discoverChannels(configuredProvider('meta'), { accessToken: userToken }, {
    fetch: async (url, options) => {
      const parsed = new URL(url);
      requests.push(parsed);
      assert.equal(parsed.origin, 'https://graph.facebook.com');
      assert.equal(options.headers.Authorization, `Bearer ${userToken}`);
      if (requests.length === 1) {
        return jsonResponse({ data: [{ id: 'page-one', name: 'Page One', access_token: 'page-one-token' }], paging: { next: 'http://169.254.169.254/latest/meta-data/?access_token=unsafe', cursors: { after: 'trusted-cursor&extra=encoded' } } });
      }
      assert.equal(parsed.searchParams.get('after'), 'trusted-cursor&extra=encoded');
      assert.equal(parsed.searchParams.has('extra'), false);
      return jsonResponse({ data: [{ id: 'page-two', name: 'Page Two', access_token: 'page-two-token' }] });
    },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(channels.map(({ accountId, tokens }) => [accountId, tokens.accessToken]), [['page-one', 'page-one-token'], ['page-two', 'page-two-token']]);
});

test('YouTube pagination encodes cursor data on the fixed API host and deduplicates channel identity', async () => {
  let requests = 0;
  const channels = await discoverChannels(configuredProvider('youtube'), { accessToken: userToken }, {
    fetch: async (url) => {
      requests += 1;
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://www.googleapis.com');
      if (requests === 1) return jsonResponse({ items: [{ id: 'UCone', snippet: { title: 'Channel One' } }], nextPageToken: 'https://evil.example.test/?token=unsafe' });
      assert.equal(parsed.searchParams.get('pageToken'), 'https://evil.example.test/?token=unsafe');
      return jsonResponse({ items: [{ id: 'UCone', snippet: { title: 'Channel One' } }, { id: 'UCtwo', snippet: { title: 'Channel Two' } }] });
    },
  });
  assert.equal(requests, 2);
  assert.deepEqual(channels.map((channel) => channel.accountId), ['UCone', 'UCtwo']);
});

test('repeated pagination cursors fail safely without looping or leaking tokens', async () => {
  let requests = 0;
  await assert.rejects(discoverChannels(configuredProvider('meta'), { accessToken: userToken }, {
    fetch: async () => {
      requests += 1;
      return jsonResponse({ data: [], paging: { next: 'https://evil.example.test', cursors: { after: 'same-cursor' } } });
    },
  }), safeError('provider_account_discovery_failed'));
  assert.equal(requests, 2);
});

test('provider identity failures never synthesize an account and unsafe profile URLs are omitted', async () => {
  await assert.rejects(discoverChannels(configuredProvider('linkedin'), { accessToken: userToken }, { fetch: async () => jsonResponse({ name: 'Missing Verified Identity', error_description: 'sensitive-provider-message' }) }), safeError('provider_account_discovery_failed'));
  await assert.rejects(discoverChannels(configuredProvider('tiktok'), { accessToken: userToken }, { fetch: async () => jsonResponse({ error: { code: 'access_token_invalid', message: 'sensitive-provider-message' } }) }), safeError('provider_account_discovery_failed'));
  const [channel] = await discoverChannels(configuredProvider('tiktok'), { accessToken: userToken }, {
    fetch: async () => jsonResponse({ data: { user: { open_id: 'verified-id', display_name: `\u0000${'a'.repeat(250)}`, username: 'verified-user', profile_deep_link: 'javascript:alert(1)' } }, error: { code: 'ok' } }),
  });
  assert.equal(channel.accountId, 'verified-id');
  assert.equal(channel.name.length, 160);
  assert.equal(channel.name.includes('\u0000'), false);
  assert.equal(channel.url, undefined);
});

test('public account metadata omits URLs containing provider credentials or authorization codes', async () => {
  const unsafeUrls = [
    ...['access_token', 'refresh_token', 'client_secret', 'id_token', 'authorization', 'code'].map((field) => `https://www.tiktok.com/@verified?${field}=sensitive-provider-message`),
    'https://www.tiktok.com/@verified#access_token=sensitive-provider-message',
    'https://www.tiktok.com/@verified#refresh_token=sensitive-provider-message',
    'https://www.tiktok.com/@verified#id_token=sensitive-provider-message',
    'https://user:password@www.tiktok.com/@verified',
    'http://www.tiktok.com/@verified',
  ];
  for (const profileUrl of unsafeUrls) {
    const [channel] = await discoverChannels(configuredProvider('tiktok'), { accessToken: userToken }, {
      fetch: async () => jsonResponse({ data: { user: { open_id: 'verified-id', display_name: 'Verified Account', profile_deep_link: profileUrl } }, error: { code: 'ok' } }),
    });
    assert.equal(channel.url, undefined);
    assert.equal(channel.accountId, 'verified-id');
  }
  const [page] = await discoverChannels(configuredProvider('meta'), { accessToken: userToken }, {
    fetch: async () => jsonResponse({ data: [{ id: 'verified-page', name: 'Verified Page', access_token: pageToken, link: 'https://www.facebook.com/page?access_token=sensitive-provider-message' }] }),
  });
  assert.equal(page.url, 'https://www.facebook.com/verified-page');
});
