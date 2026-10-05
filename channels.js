const SERVICE_KEY = 'emc-channel-service-url';
const SESSION_KEY = 'emc-channel-session-v1';
const REQUEST_TIMEOUT = 12000;
const PROVIDERS = Object.freeze({
  meta: { name: 'Instagram / Facebook', platforms: ['Instagram', 'Facebook'] },
  tiktok: { name: 'TikTok', platforms: ['TikTok'] },
  linkedin: { name: 'LinkedIn', platforms: ['LinkedIn'] },
  youtube: { name: 'YouTube', platforms: ['YouTube'] },
  pinterest: { name: 'Pinterest', platforms: ['Pinterest'] },
  x: { name: 'X', platforms: ['X'] },
});

const $ = (id) => document.getElementById(id);

class StaleRequest extends Error {}
class ServiceError extends Error {
  constructor(message, status = 0, authenticated = false) {
    super(message);
    this.status = status;
    this.authenticated = authenticated;
  }
}

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function loopback(hostname) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

function serviceUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error('Trage die vollständige HTTPS-Adresse des Verbindungsdiensts ein.'); }
  if (input.length > 2048 || /[\u0000-\u0020\u007f]/.test(input) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('Verwende nur die Adresse des Verbindungsdiensts, ohne Zugangsdaten, Unterpfad oder zusätzliche Parameter.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback(parsed.hostname) && loopback(location.hostname))) {
    throw new Error('Der Verbindungsdienst benötigt eine sichere HTTPS-Adresse.');
  }
  return parsed.origin;
}

function publicUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return '';
  try {
    const parsed = new URL(value);
    const fragment = new URLSearchParams(parsed.hash.slice(1));
    const sensitiveKeys = new Set(['access_token', 'refresh_token', 'client_secret', 'id_token', 'code', 'session_token', 'token', 'authorization']);
    if ([...parsed.searchParams.keys(), ...fragment.keys()].some((key) => sensitiveKeys.has(key.toLowerCase()))) return '';
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : '';
  } catch { return ''; }
}

function safeText(value, limit = 256) {
  return typeof value === 'string' && value.trim() && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : '';
}

function expiry(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > Date.now() ? value : '';
}

function sessionData(value, baseUrl) {
  if (!value || typeof value !== 'object' || value.baseUrl !== baseUrl || typeof value.token !== 'string' || !/^[\x21-\x7e]{12,1024}$/.test(value.token) || !expiry(value.expiresAt)) return null;
  return { baseUrl, token: value.token, expiresAt: value.expiresAt };
}

function authorizedUrl(value, provider, baseUrl) {
  if (typeof value !== 'string' || value.length > 16000 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('Die Plattform-Anmeldung konnte nicht sicher geöffnet werden.');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Die Plattform-Anmeldung konnte nicht sicher geöffnet werden.'); }
  if (parsed.origin !== baseUrl || parsed.username || parsed.password || parsed.pathname !== `/oauth/${provider}/start` || parsed.hash || !/^[A-Za-z0-9_-]{43}$/.test(parsed.searchParams.get('state') || '') || [...parsed.searchParams.keys()].length !== 1) {
    throw new Error('Der Verbindungsdienst hat keine gültige Plattform-Anmeldung zurückgegeben.');
  }
  for (const key of ['access_token', 'refresh_token', 'client_secret', 'id_token']) {
    if (parsed.searchParams.has(key)) throw new Error('Der Verbindungsdienst hat keine gültige Plattform-Anmeldung zurückgegeben.');
  }
  return parsed.href;
}

function channelData(raw) {
  if (!raw || typeof raw !== 'object' || !Object.hasOwn(PROVIDERS, raw.provider) || !PROVIDERS[raw.provider].platforms.includes(raw.platform) || typeof raw.id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(raw.id) || !safeText(raw.name)) {
    throw new Error('Die Kontenliste des Verbindungsdiensts ist ungültig. Bitte prüfe die Einrichtung.');
  }
  // Only public metadata reaches the planner. Provider credentials are never copied.
  const result = { id: raw.id, provider: raw.provider, platform: raw.platform, name: safeText(raw.name), kind: 'social', requiresReconnect: raw.requiresReconnect === true };
  for (const key of ['accountId', 'handle', 'connectedAt', 'updatedAt']) {
    const value = safeText(raw[key], key === 'accountId' ? 256 : 200);
    if (value) result[key] = value;
  }
  const url = publicUrl(raw.url);
  if (url) result.url = url;
  return result;
}

/** Connect real provider accounts through the user's separately configured OAuth service. */
export function createChannelManager({ notify = () => {}, onChange = () => {}, getWebsites = () => [], editWebsite = () => {}, onDisconnect = () => {} } = {}) {
  const state = { baseUrl: '', session: null, providers: new Map(), channels: [], generation: 0, busy: false, error: '', expired: false, storageBlocked: false, initialized: false, popup: null, awaitingReturn: false };
  const controllers = new Set();
  let popupTimer;
  let queuedRefresh;

  function storedSession() {
    let raw;
    try { raw = localStorage.getItem(SESSION_KEY); }
    catch { throw new Error('Die gespeicherte Anmeldung konnte nicht gelesen werden. Erlaube Browserspeicher und prüfe die Verbindung erneut.'); }
    if (!raw) return { present: false, value: null };
    try { return { present: true, value: JSON.parse(raw) }; }
    catch { return { present: true, value: null }; }
  }

  function formError(message) {
    const target = $('connection-error');
    if (target) { target.textContent = message; target.hidden = !message; }
  }

  function storeSession(value, { replace = false, expectedToken = state.session?.token } = {}) {
    const stored = storedSession();
    if (!replace && stored.present && ((expectedToken && stored.value?.token !== expectedToken) || (value && stored.value?.token !== value.token))) throw new StaleRequest();
    try {
      if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      state.storageBlocked = true;
      throw new Error('Dieser Browser kann die Anmeldung nicht speichern. Erlaube Browserspeicher und prüfe die Verbindung erneut.');
    }
    state.session = value;
  }

  function publish(channels) {
    state.channels = channels;
    onChange(channels.map((channel) => ({ ...channel })));
  }

  function endPopup(close = true) {
    clearInterval(popupTimer);
    popupTimer = undefined;
    if (close && state.popup?.window && !state.popup.window.closed) state.popup.window.close();
    state.popup = null;
  }

  function expireSession() {
    const expectedToken = state.session?.token;
    state.expired = true;
    state.session = null;
    endPopup();
    publish([]);
    storeSession(null, { expectedToken });
  }

  function isCurrent(generation) {
    if (generation !== state.generation) throw new StaleRequest();
  }

  async function request(path, { method = 'GET', authenticated = false, generation = state.generation } = {}) {
    isCurrent(generation);
    const baseUrl = state.baseUrl;
    if (!baseUrl) throw new Error('Richte zuerst den Verbindungsdienst ein.');
    if (authenticated && (!state.session || state.session.baseUrl !== baseUrl || !expiry(state.session.expiresAt))) {
      throw new ServiceError('Deine Sitzung ist abgelaufen. Starte in den Verbindungseinstellungen eine neue Sitzung und verknüpfe deine Konten erneut.', 401, true);
    }
    if (authenticated && storedSession().value?.token !== state.session.token) throw new StaleRequest();
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const headers = { Accept: 'application/json' };
    if (authenticated) headers.Authorization = `Bearer ${state.session.token}`;
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}), signal: controller.signal, credentials: 'omit', mode: 'cors', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
      isCurrent(generation);
      if (!response.ok) {
        const message = response.status === 401 || response.status === 403 ? 'Die Anmeldung beim Verbindungsdienst ist nicht mehr gültig. Öffne „Verbindung einrichten“, um eine neue Sitzung zu starten.' : response.status === 429 ? 'Der Verbindungsdienst erhält gerade zu viele Anfragen. Versuche es in einer Minute erneut.' : 'Der Verbindungsdienst konnte die Anfrage nicht abschließen. Bitte prüfe seine Einrichtung und versuche es erneut.';
        throw new ServiceError(message, response.status, authenticated);
      }
      if (!response.headers.get('Content-Type')?.toLowerCase().includes('application/json')) throw new Error('Die Adresse liefert keinen passenden Verbindungsdienst. Bitte prüfe die HTTPS-Adresse.');
      const body = await response.text();
      isCurrent(generation);
      if (body.length > 256000) throw new Error('Die Antwort des Verbindungsdiensts ist zu groß. Bitte prüfe seine Einrichtung.');
      let result;
      try { result = JSON.parse(body); } catch { throw new Error('Der Verbindungsdienst hat eine ungültige Antwort zurückgegeben.'); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Der Verbindungsdienst hat eine ungültige Antwort zurückgegeben.');
      return result;
    } catch (error) {
      isCurrent(generation);
      if (error instanceof ServiceError) throw error;
      if (error instanceof TypeError || error?.name === 'AbortError') {
        throw new Error(error?.name === 'AbortError' ? 'Der Verbindungsdienst antwortet nicht rechtzeitig. Bitte versuche es erneut.' : 'Der Verbindungsdienst ist nicht erreichbar. Prüfe deine Internetverbindung und die Adresse des Diensts.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }

  async function load(generation, allowNewSession) {
    const config = await request('/api/config', { generation });
    if (!Array.isArray(config.providers) || config.providers.length > 20 || config.frontendOrigin !== location.origin) {
      throw new Error('Der Verbindungsdienst ist nicht für diesen Planer eingerichtet. Bitte prüfe die freigegebene App-Adresse.');
    }
    const providers = new Map();
    for (const provider of config.providers) {
      if (provider && Object.hasOwn(PROVIDERS, provider.id)) providers.set(provider.id, { configured: provider.configured === true, ready: provider.authorizationReady === true });
    }
    state.providers = providers;
    const acquireSession = async () => {
      isCurrent(generation);
      const stored = storedSession();
      const current = sessionData(stored.value, state.baseUrl);
      if (current) { state.session = current; state.expired = false; return; }
      if (stored.present || state.session) {
        state.session = null;
        state.expired = true;
      }
      if (!allowNewSession || state.expired) throw new Error('Deine Sitzung ist abgelaufen. Starte in den Verbindungseinstellungen eine neue Sitzung und verknüpfe deine Konten erneut.');
      if (!navigator.locks?.request) throw new Error('Für die sichere Kontenanmeldung benötigst du eine aktuelle Version von Safari, Chrome, Edge oder Firefox.');
      const created = await request('/api/session', { method: 'POST', generation });
      const session = sessionData({ baseUrl: state.baseUrl, token: created.sessionToken, expiresAt: created.expiresAt }, state.baseUrl);
      if (!session) throw new Error('Der Verbindungsdienst konnte keine gültige Sitzung bereitstellen.');
      storeSession(session);
    };
    // Tabs share the same account workspace. Only one may create its identity.
    if (navigator.locks?.request) await navigator.locks.request(`emc-channel-session:${state.baseUrl}`, acquireSession);
    else await acquireSession();
    const result = await request('/api/channels', { authenticated: true, generation });
    if (!Array.isArray(result.channels) || result.channels.length > 1000 || !expiry(result.expiresAt)) throw new Error('Die Kontenliste des Verbindungsdiensts ist ungültig. Bitte prüfe die Einrichtung.');
    const channels = result.channels.map(channelData);
    if (new Set(channels.map((channel) => channel.id)).size !== channels.length) throw new Error('Die Kontenliste enthält doppelte Einträge. Bitte prüfe den Verbindungsdienst.');
    storeSession({ ...state.session, expiresAt: result.expiresAt });
    publish(channels);
    state.error = '';
  }

  function handleFailure(error, silent = false) {
    if (error instanceof StaleRequest) return false;
    if (error instanceof ServiceError && error.authenticated && [401, 403].includes(error.status)) {
      try { expireSession(); } catch (storageError) { error = storageError; }
    }
    if (error instanceof StaleRequest) return false;
    state.error = error instanceof Error ? error.message : 'Die Verbindung konnte nicht geprüft werden.';
    if (!silent) notify(state.error, true);
    return false;
  }

  async function refresh({ allowNewSession = !state.expired, silent = false } = {}) {
    if (!state.baseUrl) { render(); return false; }
    if (state.busy) {
      if (!queuedRefresh) {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        queuedRefresh = { promise, resolve };
      }
      return queuedRefresh.promise;
    }
    const generation = state.generation;
    state.busy = true;
    state.error = '';
    render();
    try {
      await load(generation, allowNewSession);
      return true;
    } catch (error) {
      return handleFailure(error, silent);
    } finally {
      finishBusy(generation);
    }
  }

  function finishBusy(generation) {
    if (generation !== state.generation) return;
    state.busy = false;
    render();
    if (queuedRefresh) {
      const queued = queuedRefresh;
      queuedRefresh = undefined;
      void refresh({ allowNewSession: false }).then(queued.resolve);
    }
  }

  function card(channel, website = false) {
    const result = node('article', 'channel-card');
    result.dataset.channelId = channel.id;
    result.dataset.kind = website ? 'website' : 'social';
    const header = node('div', 'channel-card-header');
    const platform = node('span', 'platform-badge', website ? 'Website' : channel.platform);
    platform.dataset.platform = (website ? 'Website' : channel.platform).toLowerCase();
    header.append(platform, node('span', website ? 'channel-status channel-status-local' : channel.requiresReconnect ? 'channel-status channel-status-local' : 'channel-status', website ? 'Website-Adresse hinterlegt' : channel.requiresReconnect ? 'Erneut anmelden' : 'Verbunden'));
    result.append(header, node('h3', 'channel-card-title', channel.name));
    if (!website && channel.handle) result.append(node('p', 'channel-handle', channel.handle));
    const url = publicUrl(channel.url);
    if (url) {
      const link = node('a', 'channel-url', website ? new URL(url).hostname : 'Profil öffnen');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      result.append(link);
    }
    const actions = node('div', 'channel-card-actions');
    const action = node('button', `button button-secondary button-small ${website ? 'edit-website' : 'disconnect-channel'}`, website ? 'Bearbeiten' : 'Verbindung entfernen');
    action.type = 'button';
    action.setAttribute('aria-label', website ? `Website „${channel.name}“ bearbeiten` : `Verbindung zu „${channel.name}“ entfernen`);
    action.disabled = !website && (state.busy || !state.session || state.expired || state.storageBlocked);
    action.addEventListener('click', () => website ? editWebsite(channel) : disconnect(channel, action));
    actions.append(action);
    result.append(actions);
    return result;
  }

  function render() {
    const websites = getWebsites();
    const cards = [...state.channels.map((channel) => card(channel)), ...websites.map((website) => card(website, true))];
    $('channels-list')?.replaceChildren(...cards);
    if ($('channel-empty')) $('channel-empty').hidden = cards.length > 0;
    const ready = [...state.providers.values()].some((provider) => provider.configured && provider.ready);
    const canConnect = Boolean(state.baseUrl && state.session && expiry(state.session.expiresAt) && !state.busy && !state.error && !state.expired && !state.storageBlocked && !state.popup);
    for (const button of document.querySelectorAll('[data-connect-provider]')) {
      const provider = state.providers.get(button.dataset.connectProvider);
      button.disabled = !(canConnect && provider?.configured && provider?.ready);
      button.title = button.disabled ? (!state.baseUrl ? 'Richte zuerst den Verbindungsdienst ein.' : !provider?.configured || !provider?.ready ? 'Diese Plattform ist im Verbindungsdienst noch nicht freigeschaltet.' : 'Die Verbindung muss erneut geprüft werden.') : `Weiter zur Anmeldung bei ${PROVIDERS[button.dataset.connectProvider].name}`;
    }
    if ($('refresh-channels')) $('refresh-channels').disabled = !state.baseUrl || state.busy;
    const submit = $('save-connection');
    if (submit) {
      submit.disabled = state.busy;
      submit.lastChild && (submit.lastChild.textContent = state.expired ? 'Neue Sitzung starten' : 'Verbindung prüfen');
    }
    let message = 'Noch kein Verbindungsdienst eingerichtet. Eine Website-Adresse kannst du direkt hinzufügen.';
    if (state.busy) message = 'Deine Verbindung und freigegebenen Konten werden geprüft …';
    else if (state.error) message = state.error;
    else if (state.popup) message = `Die Anmeldung bei ${PROVIDERS[state.popup.provider].name} ist geöffnet. Wähle dort deine Konten aus.`;
    else if (state.baseUrl && state.channels.length) {
      const connected = state.channels.filter((channel) => !channel.requiresReconnect).length;
      const expired = state.channels.length - connected;
      message = connected ? `${connected} ${connected === 1 ? 'Konto verbunden' : 'Konten verbunden'}.` : 'Deine Konten sind hinterlegt.';
      if (expired) message += ` Für ${expired === 1 ? 'ein Konto ist' : `${expired} Konten ist`} eine erneute Plattform-Anmeldung nötig.`;
      message += ready ? ' Wähle eine Plattform, um Konten hinzuzufügen oder erneut anzumelden.' : ' Weitere Plattform-Anmeldungen müssen im Verbindungsdienst freigeschaltet werden.';
    }
    else if (state.baseUrl && ready && state.session) message = 'Verbindungsdienst bereit. Wähle eine Plattform, um dein erstes Konto zu verknüpfen.';
    else if (state.baseUrl) message = 'Noch keine Plattform-Anmeldung freigeschaltet. Die Einrichtung des Verbindungsdiensts muss vervollständigt werden.';
    const status = $('channel-connection-status');
    if (status) { status.textContent = message; status.classList.toggle('is-error', Boolean(state.error)); }
  }

  async function disconnect(channel, button) {
    if (state.busy || !state.session) return;
    if (!window.confirm(`Verbindung zu „${channel.name}“ entfernen? Beiträge bleiben erhalten; ihre Zuordnung zu diesem Konto wird aufgehoben.`)) return;
    const generation = state.generation;
    state.busy = true;
    button.disabled = true;
    render();
    try {
      await request(`/api/channels/${encodeURIComponent(channel.id)}`, { method: 'DELETE', authenticated: true, generation });
      publish(state.channels.filter((item) => item.id !== channel.id));
      onDisconnect(channel.id);
      state.error = '';
      notify('Das Konto wurde aus dem Planer entfernt. Plattformfreigaben kannst du zusätzlich in den Einstellungen der Plattform widerrufen.');
    } catch (error) { handleFailure(error); }
    finally { finishBusy(generation); }
  }

  async function connect(provider) {
    const configured = state.providers.get(provider);
    if (!Object.hasOwn(PROVIDERS, provider) || !configured?.configured || !configured?.ready || !state.session || state.busy || state.error || state.expired || state.storageBlocked) return;
    if (state.popup && !state.popup.window.closed) { state.popup.window.focus(); return; }
    // Opening before the first await keeps this a direct response to the user's tap.
    const popup = window.open('about:blank', '_blank', 'popup,width=640,height=760');
    if (!popup) { notify('Erlaube das Anmeldefenster für den Planer in deinem Browser und versuche es erneut.', true); return; }
    const generation = state.generation;
    state.popup = { window: popup, provider, generation };
    state.awaitingReturn = true;
    render();
    try {
      const result = await request(`/api/connect/${encodeURIComponent(provider)}`, { method: 'POST', authenticated: true, generation });
      const url = authorizedUrl(result.authorizationUrl, provider, state.baseUrl);
      if (!state.popup || state.popup.window !== popup || popup.closed) return;
      popup.location.replace(url);
      popupTimer = setInterval(() => {
        if (popup.closed) {
          endPopup(false);
          void refresh({ allowNewSession: false });
        }
      }, 750);
    } catch (error) {
      if (state.popup?.window === popup) endPopup();
      handleFailure(error);
      render();
    }
  }

  async function oauthMessage(event) {
    const current = state.popup;
    if (!current || current.generation !== state.generation || event.source !== current.window || event.origin !== state.baseUrl || !event.data || typeof event.data !== 'object' || event.data.provider !== current.provider) return;
    if (event.data.type === 'emc-oauth-ready') {
      if (!state.session || !expiry(state.session.expiresAt)) {
        endPopup();
        handleFailure(new ServiceError('Deine Sitzung ist abgelaufen. Starte in den Verbindungseinstellungen eine neue Sitzung und verknüpfe deine Konten erneut.', 401, true));
        render();
        return;
      }
      // The session credential is sent only to the exact service origin and popup
      // that this manager opened. Provider pages never receive this message.
      current.window.postMessage({ type: 'emc-oauth-bind', sessionToken: state.session.token }, state.baseUrl);
      return;
    }
    if (event.data.type !== 'emc-oauth' || typeof event.data.ok !== 'boolean') return;
    state.awaitingReturn = false;
    endPopup();
    if (!event.data.ok) {
      notify('Die Plattform-Anmeldung wurde nicht abgeschlossen. Prüfe die Freigaben und versuche es erneut.', true);
      render();
      return;
    }
    if (await refresh({ allowNewSession: false })) {
      notify(state.channels.length ? 'Deine freigegebenen Konten wurden aktualisiert.' : 'Die Anmeldung ist abgeschlossen. Es wurden noch keine freigegebenen Konten gefunden. Prüfe die Kontoauswahl bei der Plattform.', state.channels.length === 0);
    }
  }

  function openSettings() {
    if ($('connection-url')) $('connection-url').value = state.baseUrl;
    formError(state.expired ? 'Deine Sitzung ist abgelaufen. Eine neue Sitzung beginnt einen neuen Kontobereich. Verknüpfe deine Konten danach erneut.' : '');
    $('connection-dialog')?.showModal();
    $('connection-url')?.focus();
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (state.busy) return;
    formError('');
    let baseUrl;
    try {
      baseUrl = serviceUrl($('connection-url')?.value);
      if (baseUrl) localStorage.setItem(SERVICE_KEY, baseUrl);
      else localStorage.removeItem(SERVICE_KEY);
    } catch (error) { formError(error instanceof Error ? error.message : 'Die Verbindungseinstellung konnte nicht gespeichert werden.'); return; }
    const changed = baseUrl !== state.baseUrl;
    if (changed || state.expired || state.storageBlocked) {
      state.generation += 1;
      for (const controller of controllers) controller.abort();
      endPopup();
      state.baseUrl = baseUrl;
      state.session = null;
      state.awaitingReturn = false;
      state.providers = new Map();
      state.expired = false;
      state.storageBlocked = false;
      state.error = '';
      publish([]);
      try { storeSession(null, { replace: true }); } catch (error) { state.error = error.message; formError(state.error); render(); return; }
    }
    if (!baseUrl) {
      render();
      $('connection-dialog')?.close();
      notify('Die Adresse des Verbindungsdiensts wurde auf diesem Gerät entfernt.');
      return;
    }
    const generation = state.generation;
    if (await refresh({ allowNewSession: true })) {
      if (generation === state.generation) $('connection-dialog')?.close();
      notify('Der Verbindungsdienst wurde geprüft. Verfügbare Plattform-Anmeldungen sind jetzt freigeschaltet.');
    } else if (generation === state.generation) formError(state.error);
  }

  async function init() {
    if (state.initialized) return;
    state.initialized = true;
    $('connection-settings')?.addEventListener('click', openSettings);
    $('connection-form')?.addEventListener('submit', saveSettings);
    $('refresh-channels')?.addEventListener('click', () => { void refresh(); });
    $('add-website')?.addEventListener('click', () => editWebsite(null));
    for (const button of document.querySelectorAll('[data-connect-provider]')) button.addEventListener('click', () => { void connect(button.dataset.connectProvider); });
    window.addEventListener('message', (event) => { void oauthMessage(event); });
    window.addEventListener('pagehide', () => endPopup());
    const refreshOnReturn = () => {
      if (!state.awaitingReturn || state.busy || !state.baseUrl || !state.session || document.visibilityState === 'hidden') return;
      state.awaitingReturn = false;
      if (state.popup?.window.closed) endPopup(false);
      void refresh({ allowNewSession: false });
    };
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);
    window.addEventListener('storage', (event) => {
      if (![SERVICE_KEY, SESSION_KEY, null].includes(event.key)) return;
      try {
        const baseUrl = serviceUrl(localStorage.getItem(SERVICE_KEY));
        const canonical = sessionData(storedSession().value, baseUrl);
        if (baseUrl === state.baseUrl && canonical && canonical.token === state.session?.token) {
          // A renewed expiry belongs to the same workspace. Refetching here
          // would make two tabs repeatedly renew each other's sessions.
          state.session = canonical;
          return;
        }
      } catch { /* The complete handler below surfaces inaccessible storage. */ }
      const previousBase = state.baseUrl;
      const hadSession = Boolean(state.session);
      state.generation += 1;
      for (const controller of controllers) controller.abort();
      endPopup();
      state.awaitingReturn = false;
      state.busy = false;
      state.providers = new Map();
      if (queuedRefresh) { queuedRefresh.resolve(false); queuedRefresh = undefined; }
      publish([]);
      try {
        state.baseUrl = serviceUrl(localStorage.getItem(SERVICE_KEY));
        const stored = storedSession();
        state.session = sessionData(stored.value, state.baseUrl);
        state.expired = !state.session && (stored.present || (hadSession && previousBase === state.baseUrl));
        state.error = state.expired ? 'Die Anmeldung wurde in einem anderen Fenster geändert oder beendet. Öffne „Verbindung einrichten“, um eine neue Sitzung zu starten.' : '';
        state.storageBlocked = false;
      } catch {
        state.session = null;
        state.storageBlocked = true;
        state.error = 'Die Verbindungseinstellungen konnten nicht gelesen werden. Erlaube Browserspeicher und prüfe die Verbindung erneut.';
      }
      render();
      if (state.baseUrl && !state.expired && !state.storageBlocked) void refresh({ allowNewSession: true, silent: true });
    });
    try {
      state.baseUrl = serviceUrl(localStorage.getItem(SERVICE_KEY));
      const stored = localStorage.getItem(SESSION_KEY);
      if (stored && state.baseUrl) {
        let parsed;
        try { parsed = JSON.parse(stored); } catch { parsed = null; }
        state.session = sessionData(parsed, state.baseUrl);
        if (!state.session) {
          state.expired = true;
          storeSession(null);
          state.error = 'Deine Sitzung ist abgelaufen oder ungültig. Öffne „Verbindung einrichten“, um eine neue Sitzung zu starten.';
        }
      }
    } catch (error) {
      state.storageBlocked = true;
      state.error = error instanceof Error ? error.message : 'Die Verbindungseinstellungen konnten nicht gelesen werden.';
      notify(state.error, true);
    }
    render();
    if (state.baseUrl && !state.storageBlocked && !state.expired) await refresh({ allowNewSession: true, silent: true });
  }

  return { init, render, refresh };
}
