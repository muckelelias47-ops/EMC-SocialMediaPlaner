import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from '../server/index.js';

test('Offizielle Popup-Anmeldung verbindet mehrere Konten über den echten Dienst und bleibt nach Neuladen erhalten', async ({ page, context, baseURL }) => {
  const directory = await mkdtemp(join(tmpdir(), 'emc-browser-oauth-'));
  const frontendOrigin = new URL(baseURL).origin;
  let handler;
  let logins = 0;
  let sessionRequests = 0;
  const tokenRequests = [];
  const profileRequests = [];
  const server = createServer((request, response) => {
    if (request.url === '/api/session' && request.method === 'POST') sessionRequests += 1;
    if (handler) void handler(request, response);
    else { response.writeHead(503); response.end(); }
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const serviceUrl = `http://127.0.0.1:${server.address().port}`;
    handler = await createHandler({
      env: {
        PUBLIC_BASE_URL: serviceUrl,
        FRONTEND_ORIGIN: frontendOrigin,
        CHANNEL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        DATA_DIR: directory,
        LINKEDIN_CLIENT_ID: 'browser-test-client',
        LINKEDIN_CLIENT_SECRET: 'private-browser-test-client-secret',
      },
      // Only the external provider is simulated. The API, popup messages,
      // browser binding cookie, callback and encrypted store run unchanged.
      fetch: async (url, options) => {
        if (String(url) === 'https://www.linkedin.com/oauth/v2/accessToken') {
          logins += 1;
          const form = new URLSearchParams(options.body);
          tokenRequests.push({ code: form.get('code'), redirectUri: form.get('redirect_uri'), clientId: form.get('client_id') });
          return Response.json({ access_token: `private-browser-provider-access-${logins}`, refresh_token: `private-browser-provider-refresh-${logins}`, token_type: 'Bearer', expires_in: 3600 });
        }
        if (String(url) === 'https://api.linkedin.com/v2/userinfo') {
          profileRequests.push(options.headers.Authorization);
          return Response.json({ sub: `browser-linkedin-account-${logins}`, name: `EMC LinkedIn Konto ${logins}` });
        }
        throw new Error('Unexpected provider request in browser test.');
      },
    });

    await context.route('https://www.linkedin.com/oauth/v2/authorization**', async route => {
      const authorization = new URL(route.request().url());
      expect(authorization.searchParams.get('client_id')).toBe('browser-test-client');
      expect(authorization.searchParams.get('response_type')).toBe('code');
      expect(authorization.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      expect(callback.origin).toBe(serviceUrl);
      expect(callback.pathname).toBe('/oauth/linkedin/callback');
      callback.searchParams.set('state', authorization.searchParams.get('state'));
      callback.searchParams.set('code', `browser-provider-code-${logins + 1}`);
      await route.fulfill({ status: 302, headers: { Location: callback.href } });
    });

    await page.goto('/#channels');
    await expect(page.locator('#view-channels')).toBeVisible();
    await page.locator('#connection-settings').click();
    await page.locator('#connection-url').fill(serviceUrl);
    await page.locator('#save-connection').click();
    await expect(page.locator('#connection-dialog')).not.toBeVisible();
    await expect(page.locator('#connect-linkedin')).toBeEnabled();
    await expect(page.locator('#connect-meta')).toBeDisabled();

    async function connectAccount(number) {
      const bindingResponse = context.waitForEvent('response', { predicate: response => response.url() === `${serviceUrl}/api/oauth/bind` && response.request().method() === 'POST' });
      const callbackResponse = context.waitForEvent('response', { predicate: response => response.url().startsWith(`${serviceUrl}/oauth/linkedin/callback?`) });
      const opened = page.waitForEvent('popup');
      await page.locator('#connect-linkedin').click();
      const popup = await opened;
      const closed = popup.waitForEvent('close');
      const bound = await bindingResponse;
      expect(bound.status()).toBe(200);
      expect(await bound.headerValue('set-cookie')).toMatch(/emc_oauth_[A-Za-z0-9_-]+=.+; Path=\/oauth\/linkedin\/callback; HttpOnly; SameSite=Lax/);
      const returned = await callbackResponse;
      expect(returned.status()).toBe(200);
      const callbackHeaders = await returned.request().allHeaders();
      expect(callbackHeaders.cookie).toMatch(/emc_oauth_[A-Za-z0-9_-]+=[A-Za-z0-9_-]{43}/);
      expect(await returned.headerValue('set-cookie')).toContain('Max-Age=0');
      await closed;
      await expect(page.locator('#channels-list .channel-card')).toHaveCount(number);
      await expect(page.locator('#channels-list').getByRole('heading', { name: `EMC LinkedIn Konto ${number}`, exact: true })).toBeVisible();
      await expect(page.locator('#connect-linkedin')).toBeEnabled();
    }

    await connectAccount(1);
    await connectAccount(2);
    expect(sessionRequests).toBe(1);
    expect(tokenRequests).toEqual([
      { code: 'browser-provider-code-1', redirectUri: `${serviceUrl}/oauth/linkedin/callback`, clientId: 'browser-test-client' },
      { code: 'browser-provider-code-2', redirectUri: `${serviceUrl}/oauth/linkedin/callback`, clientId: 'browser-test-client' },
    ]);
    expect(profileRequests).toEqual(['Bearer private-browser-provider-access-1', 'Bearer private-browser-provider-access-2']);

    const ownSession = await page.evaluate(() => JSON.parse(localStorage.getItem('emc-channel-session-v1')));
    expect(ownSession).toMatchObject({ baseUrl: serviceUrl });
    expect(ownSession.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const browserHasProviderCredentials = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => /private-browser-provider-|private-browser-test-client-secret/.test(value)));
    expect(browserHasProviderCredentials).toBe(false);
    const encryptedFile = await readFile(join(directory, 'channels.enc.json'), 'utf8');
    expect(encryptedFile).not.toContain('private-browser-provider-');
    expect(encryptedFile).not.toContain('browser-linkedin-account-');

    await page.reload();
    await expect(page.locator('#channels-list .channel-card')).toHaveCount(2);
    await expect(page.locator('#channels-list').getByRole('heading', { name: 'EMC LinkedIn Konto 1', exact: true })).toBeVisible();
    await expect(page.locator('#channels-list').getByRole('heading', { name: 'EMC LinkedIn Konto 2', exact: true })).toBeVisible();
    expect(sessionRequests).toBe(1);
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem('emc-channel-session-v1')))).token).toBe(ownSession.token);

    await page.locator('#help-open:visible, #settings-open:visible, [data-open-help]:visible').first().click();
    const downloaded = page.waitForEvent('download');
    await page.locator('#export-data').click();
    const backup = await readFile(await (await downloaded).path(), 'utf8');
    expect(backup).not.toContain(ownSession.token);
    expect(backup).not.toContain('private-browser-provider-');
    expect(backup).not.toContain('private-browser-test-client-secret');
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await handler?.store?.queue;
    await rm(directory, { recursive: true, force: true });
  }
});
