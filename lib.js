export const PLATFORMS = ['Instagram', 'Facebook', 'TikTok', 'LinkedIn', 'YouTube', 'Pinterest', 'X', 'Website'];
export const STORAGE_KEY = 'emc-social-planner-v1';
const STATUSES = ['draft', 'planned', 'published'];

export function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `post-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function stringField(value, fallback = '') {
  if (value == null) return fallback;
  if (typeof value !== 'string') throw new Error('Die Beitragsdaten haben ein ungültiges Format.');
  return value;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 9999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validatePost(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Ein Beitrag hat ein ungültiges Format.');
  const title = stringField(input.title).trim();
  const content = stringField(input.content);
  if (!title || title.length > 120) throw new Error('Bitte gib einen Titel mit höchstens 120 Zeichen ein.');
  if (content.length > 10000) throw new Error('Der Beitragstext darf höchstens 10.000 Zeichen enthalten.');
  const platform = stringField(input.platform);
  const status = stringField(input.status, 'draft');
  if (!PLATFORMS.includes(platform)) throw new Error('Bitte wähle eine gültige Plattform aus.');
  if (!STATUSES.includes(status)) throw new Error('Bitte wähle einen gültigen Status aus.');
  const date = stringField(input.date);
  const time = stringField(input.time);
  if (date && !validDate(date)) throw new Error('Bitte gib ein gültiges Datum ein.');
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Bitte gib eine gültige Uhrzeit ein.');
  if (status === 'planned' && (!date || !time)) throw new Error('Ein geplanter Beitrag braucht ein Datum und eine Uhrzeit.');
  const image = stringField(input.image);
  if (image && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(image) || image.length > 3000000)) {
    throw new Error('Das Beitragsbild ist ungültig oder zu groß. Bitte wähle ein kleineres Bild.');
  }
  const id = stringField(input.id, uid());
  if (!id || id.length > 100) throw new Error('Die Beitragskennung ist ungültig.');
  const categoryId = stringField(input.categoryId);
  const channelId = stringField(input.channelId);
  if (categoryId.length > 100) throw new Error('Die Kategorienkennung ist ungültig.');
  if (channelId.length > 100) throw new Error('Die Kanalkennung ist ungültig.');
  const now = new Date().toISOString();
  const createdAt = stringField(input.createdAt, now);
  const updatedAt = stringField(input.updatedAt, now);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new Error('Die Zeitangaben des Beitrags sind ungültig.');
  return { id, title, content, platform, status, date, time, image, categoryId, channelId, createdAt, updatedAt };
}

export function validateCategory(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Eine Kategorie hat ein ungültiges Format.');
  const id = stringField(input.id, uid());
  const name = stringField(input.name).trim();
  const color = stringField(input.color).toLowerCase();
  if (!id || id.length > 100) throw new Error('Die Kategorienkennung ist ungültig.');
  if (!name || name.length > 40) throw new Error('Bitte gib einen Kategorienamen mit höchstens 40 Zeichen ein.');
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new Error('Bitte wähle eine gültige Kategorienfarbe aus.');
  return { id, name, color };
}

export function validateWebsite(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Eine Website hat ein ungültiges Format.');
  const id = stringField(input.id, uid());
  const name = stringField(input.name).trim();
  const address = stringField(input.url).trim();
  if (!id || id.length > 100) throw new Error('Die Websitekennung ist ungültig.');
  if (!name || name.length > 80) throw new Error('Bitte gib einen Websitenamen mit höchstens 80 Zeichen ein.');
  if (!address || address.length > 2048) throw new Error('Bitte gib eine gültige HTTPS-Adresse mit höchstens 2.048 Zeichen ein.');
  let url;
  try { url = new URL(address); } catch { throw new Error('Bitte gib eine gültige HTTPS-Adresse ein.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.href.length > 2048) {
    throw new Error('Die Website braucht eine HTTPS-Adresse ohne Zugangsdaten oder Anker.');
  }
  return { id, name, url: url.href, platform: 'Website', kind: 'website' };
}

function validateCollection(posts) {
  if (!Array.isArray(posts) || posts.length > 5000) throw new Error('Die Sicherung muss eine Liste mit höchstens 5.000 Beiträgen enthalten.');
  const normalized = posts.map(validatePost);
  if (new Set(normalized.map(post => post.id)).size !== normalized.length) throw new Error('Die Sicherung enthält doppelte Beitragskennungen.');
  return normalized;
}

function validateWorkspace(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Die Arbeitsdaten haben ein ungültiges Format.');
  const posts = validateCollection(input.posts);
  if (!Array.isArray(input.categories) || input.categories.length > 100) throw new Error('Die Sicherung darf höchstens 100 Kategorien enthalten.');
  const categories = input.categories.map(validateCategory);
  const ids = new Set(categories.map(category => category.id));
  if (ids.size !== categories.length) throw new Error('Die Sicherung enthält doppelte Kategorienkennungen.');
  if (new Set(categories.map(category => category.name.toLowerCase())).size !== categories.length) throw new Error('Die Kategorienamen müssen eindeutig sein.');
  if (posts.some(post => post.categoryId && !ids.has(post.categoryId))) throw new Error('Ein Beitrag verweist auf eine unbekannte Kategorie.');
  const websiteInput = input.websites === undefined ? [] : input.websites;
  if (!Array.isArray(websiteInput) || websiteInput.length > 100) throw new Error('Die Sicherung darf höchstens 100 Websites enthalten.');
  const websites = websiteInput.map(validateWebsite);
  const websiteIds = new Set(websites.map(website => website.id));
  if (websiteIds.size !== websites.length) throw new Error('Die Sicherung enthält doppelte Websitekennungen.');
  if (new Set(websites.map(website => website.url)).size !== websites.length) throw new Error('Eine Website-Adresse darf nur einmal hinterlegt sein.');
  if (posts.some(post => post.platform === 'Website' && post.channelId && !websiteIds.has(post.channelId))) throw new Error('Ein Beitrag verweist auf eine unbekannte Website.');
  if (posts.some(post => post.platform !== 'Website' && websiteIds.has(post.channelId))) throw new Error('Ein Website-Kanal gehört zur Plattform Website.');
  return { version: 2, posts, categories, websites };
}

export function importWorkspace(text) {
  if (typeof text !== 'string' || text.length > 25000000) throw new Error('Die Sicherung ist zu groß (maximal 25 MB).');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Diese Datei ist keine gültige JSON-Sicherung.'); }
  if (Array.isArray(data)) return validateWorkspace({ posts: data, categories: [] });
  if (!data || typeof data !== 'object' || ![1, 2].includes(data.version)) throw new Error('Dieses Sicherungsformat wird nicht unterstützt.');
  return validateWorkspace({ posts: data.posts, categories: data.version === 1 ? [] : data.categories, websites: data.version === 1 ? [] : data.websites });
}

export function loadWorkspace() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { throw new Error('Der Browser erlaubt keinen lokalen Speicher. Bitte prüfe deine Browsereinstellungen.'); }
  if (raw == null) return { version: 2, posts: [], categories: [], websites: [] };
  try { return importWorkspace(raw); } catch { throw new Error('Die gespeicherten Daten konnten nicht gelesen werden. Sie bleiben erhalten. Bitte spiele eine gültige Sicherung ein.'); }
}

export function saveWorkspace(workspace) {
  const normalized = validateWorkspace(workspace);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); }
  catch { throw new Error('Speichern nicht möglich. Der Gerätespeicher ist voll oder gesperrt. Sichere deine Daten und entferne große Bilder.'); }
  return normalized;
}

export function importPosts(text) {
  return importWorkspace(text).posts;
}

export function loadPosts() {
  return loadWorkspace().posts;
}

export function savePosts(posts) {
  const normalized = validateCollection(posts);
  const workspace = loadWorkspace();
  return saveWorkspace({ ...workspace, posts: normalized });
}

export function calendarDays(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - (first.getUTCDay() + 6) % 7);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + index);
    return { date: day.toISOString().slice(0, 10), inMonth: day.getUTCMonth() === first.getUTCMonth() };
  });
}

export function formatDate(date) {
  if (!date || !validDate(date)) return 'Ohne Datum';
  return new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${date}T12:00:00`));
}

export function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
}
