export const PLATFORMS = ['Instagram', 'Facebook', 'TikTok', 'LinkedIn', 'YouTube', 'Pinterest', 'X'];
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
  const now = new Date().toISOString();
  const createdAt = stringField(input.createdAt, now);
  const updatedAt = stringField(input.updatedAt, now);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new Error('Die Zeitangaben des Beitrags sind ungültig.');
  return { id, title, content, platform, status, date, time, image, createdAt, updatedAt };
}

function validateCollection(posts) {
  if (!Array.isArray(posts) || posts.length > 5000) throw new Error('Die Sicherung muss eine Liste mit höchstens 5.000 Beiträgen enthalten.');
  const normalized = posts.map(validatePost);
  if (new Set(normalized.map(post => post.id)).size !== normalized.length) throw new Error('Die Sicherung enthält doppelte Beitragskennungen.');
  return normalized;
}

export function importPosts(text) {
  if (typeof text !== 'string' || text.length > 25000000) throw new Error('Die Sicherung ist zu groß (maximal 25 MB).');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Diese Datei ist keine gültige JSON-Sicherung.'); }
  if (Array.isArray(data)) return validateCollection(data);
  if (!data || data.version !== 1) throw new Error('Dieses Sicherungsformat wird nicht unterstützt.');
  return validateCollection(data.posts);
}

export function loadPosts() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { throw new Error('Der Browser erlaubt keinen lokalen Speicher. Bitte prüfe deine Browsereinstellungen.'); }
  if (raw == null) return [];
  try { return importPosts(raw); } catch { throw new Error('Die gespeicherten Daten konnten nicht gelesen werden. Sie bleiben erhalten. Bitte spiele eine gültige Sicherung ein.'); }
}

export function savePosts(posts) {
  const normalized = validateCollection(posts);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, posts: normalized })); }
  catch { throw new Error('Speichern nicht möglich. Der Gerätespeicher ist voll oder gesperrt. Sichere deine Daten und entferne große Bilder.'); }
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
