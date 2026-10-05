import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const STORAGE_KEY = 'emc-social-planner-v1';

async function view(page, name) {
  await page.locator(`[data-view="${name}"]:visible`).first().click();
  await expect(page.locator(`#view-${name}`)).toBeVisible();
}

async function createPost(page, { title, content = '', platform = 'Instagram', status = 'draft', date = '', time = '', categoryId = '', channelId = '' }) {
  await page.locator('#new-post').click();
  await expect(page.locator('#post-dialog')).toBeVisible();
  await page.locator('#post-title').fill(title);
  await page.locator('#post-body').fill(content);
  await page.locator('#post-platform').selectOption(platform);
  if (categoryId) await page.locator('#post-category').selectOption(categoryId);
  if (channelId) await page.locator('#post-channel').selectOption(channelId);
  await page.locator('#post-status').selectOption(status);
  await page.locator('#post-date').fill(date);
  await page.locator('#post-time').fill(time);
  await page.locator('#save-post').click();
  await expect(page.locator('#post-dialog')).not.toBeVisible();
}

async function workspace(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
}

function categoryCard(page, name) {
  return page.locator('#categories-list .category-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

function channelCard(page, name) {
  return page.locator('#channels-list .channel-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

async function createCategory(page, name, color = '#7258f5') {
  await view(page, 'categories');
  await page.locator('#new-category').click();
  await page.locator('#category-name').fill(name);
  await page.locator('#category-color').fill(color);
  await page.locator('#save-category').click();
  await expect(page.locator('#category-dialog')).not.toBeVisible();
  await expect(categoryCard(page, name)).toBeVisible();
  return (await workspace(page)).categories.find(category => category.name === name);
}

async function createWebsite(page, name, url) {
  await view(page, 'channels');
  await page.locator('#add-website').click();
  await page.locator('#website-name').fill(name);
  await page.locator('#website-url').fill(url);
  await page.locator('#save-website').click();
  await expect(page.locator('#website-dialog')).not.toBeVisible();
  await expect(channelCard(page, name)).toBeVisible();
  return (await workspace(page)).websites.find(website => website.name === name);
}

async function exportBackup(page) {
  if (!await page.locator('#help-dialog').isVisible()) await page.locator('#help-open:visible, #settings-open:visible, [data-open-help]:visible').first().click();
  const downloaded = page.waitForEvent('download');
  await page.locator('#export-data').click();
  const download = await downloaded;
  return JSON.parse(await readFile(await download.path(), 'utf8'));
}

async function fitsViewport(page) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
}

function card(page, title, list = 'posts-list') {
  return page.locator(`#${list} .post-card`).filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function importBackup(page, data) {
  if (!await page.locator('#help-dialog').isVisible()) await page.locator('#help-open:visible, #settings-open:visible, [data-open-help]:visible').first().click();
  await page.locator('#import-data').setInputFiles({ name: 'emc-sicherung.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
}

async function today(page) {
  return page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#new-post')).toBeVisible();
});

test('Beiträge erstellen, nach Neuladen bearbeiten und nach Bestätigung dauerhaft löschen', async ({ page }) => {
  await createPost(page, { title: 'Sommerideen', content: 'Drei Ideen für die nächste Kampagne.' });
  await createPost(page, { title: 'Produktvorstellung', platform: 'LinkedIn', status: 'planned', date: '2026-12-17', time: '09:30' });
  await expect(page.locator('#count-draft')).toHaveText('1');
  await expect(page.locator('#count-planned')).toHaveText('1');
  await page.reload();
  await expect(page.locator('#count-draft')).toHaveText('1');
  await expect(page.locator('#count-planned')).toHaveText('1');
  await view(page, 'posts');
  await expect(page.locator('#posts-list .post-card')).toHaveCount(2);
  await card(page, 'Sommerideen').locator('.edit-post').click();
  await expect(page.locator('#post-body')).toHaveValue('Drei Ideen für die nächste Kampagne.');
  await page.locator('#post-title').fill('Sommerideen veröffentlicht');
  await page.locator('#post-status').selectOption('published');
  await page.locator('#save-post').click();
  await expect(card(page, 'Sommerideen veröffentlicht')).toBeVisible();
  await expect(page.locator('#count-draft')).toHaveText('0');
  await expect(page.locator('#count-published')).toHaveText('1');

  await card(page, 'Sommerideen veröffentlicht').locator('.edit-post').click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#delete-post').click();
  await expect(page.locator('#post-dialog')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-post').click();
  await expect(page.locator('#post-dialog')).not.toBeVisible();
  await page.reload();
  await expect(page.locator('#posts-list .post-card')).toHaveCount(1);
  await expect(card(page, 'Produktvorstellung')).toBeVisible();
  await expect(page.locator('#count-published')).toHaveText('0');
});

test('Ein geplanter Beitrag braucht Titel, Datum und Uhrzeit', async ({ page }) => {
  await page.locator('#new-post').click();
  await page.locator('#post-status').selectOption('planned');
  await page.locator('#post-date').fill('');
  await page.locator('#post-time').fill('');
  await page.locator('#save-post').click();
  await expect(page.locator('#post-dialog')).toBeVisible();
  await expect(page.locator('#post-title:invalid')).toHaveCount(1);
  await expect(page.locator('#count-planned')).toHaveText('0');
  await page.locator('#post-title').fill('Terminierter Beitrag');
  await page.locator('#save-post').click();
  await expect(page.locator('#post-date:invalid')).toHaveCount(1);
  await page.locator('#post-date').fill('2026-12-18');
  await page.locator('#save-post').click();
  await expect(page.locator('#post-time:invalid')).toHaveCount(1);
  await page.locator('#post-time').fill('14:15');
  await page.locator('#save-post').click();
  await expect(page.locator('#post-dialog')).not.toBeVisible();
  await expect(page.locator('#count-planned')).toHaveText('1');
});

test('Suche, Plattform und Status filtern Beiträge gemeinsam', async ({ page }) => {
  await createPost(page, { title: 'Instagram Entwurf', content: 'Kaffee und Inspiration', platform: 'Instagram' });
  await createPost(page, { title: 'Instagram Termin', platform: 'Instagram', status: 'planned', date: '2026-12-17', time: '10:00' });
  await createPost(page, { title: 'LinkedIn Rückblick', platform: 'LinkedIn', status: 'published' });
  await view(page, 'posts');
  await expect(page.locator('#posts-list .post-card')).toHaveCount(3);
  await page.locator('#filter-platform').selectOption('Instagram');
  await expect(page.locator('#posts-list .post-card')).toHaveCount(2);
  await page.locator('#filter-status').selectOption('draft');
  await expect(page.locator('#posts-list .post-card')).toHaveCount(1);
  await page.locator('#search').fill('KAFFEE');
  await expect(card(page, 'Instagram Entwurf')).toBeVisible();
  await page.locator('#search').fill('Nicht vorhanden');
  await expect(page.locator('#posts-list .post-card')).toHaveCount(0);
  await expect(page.locator('#posts-empty')).toBeVisible();
  await page.locator('#search').fill('');
  await page.locator('#filter-platform').selectOption('');
  await page.locator('#filter-status').selectOption('published');
  await expect(card(page, 'LinkedIn Rückblick')).toBeVisible();
  await expect(page.locator('#posts-list .post-card')).toHaveCount(1);
});

test('Kalender zeigt Termine, wechselt Monate und übernimmt den ausgewählten Tag', async ({ page }) => {
  const date = await today(page);
  await createPost(page, { title: 'Heutige Kampagne', status: 'planned', date, time: '15:00' });
  await view(page, 'calendar');
  const day = page.locator(`.calendar-day[data-date="${date}"]`);
  await expect(day.locator('.calendar-event')).toHaveText('Heutige Kampagne');
  await day.click();
  await expect(card(page, 'Heutige Kampagne', 'calendar-selected-list')).toBeVisible();
  const month = await page.locator('#calendar-title').textContent();
  await page.locator('#calendar-next').click();
  await expect(page.locator('#calendar-title')).not.toHaveText(month);
  await page.locator('#calendar-prev').click();
  await expect(page.locator('#calendar-title')).toHaveText(month);
  await page.locator('#calendar-today').click();
  await expect(page.locator(`.calendar-day[data-date="${date}"]`)).toHaveAttribute('aria-pressed', 'true');
  const otherDay = page.locator('.calendar-day[data-outside="false"]').filter({ hasNot: page.locator('.calendar-event') }).first();
  const chosenDate = await otherDay.getAttribute('data-date');
  await otherDay.click();
  await page.locator('#calendar-selected-list').getByRole('button', { name: 'Beitrag für diesen Tag erstellen' }).click();
  await expect(page.locator('#post-date')).toHaveValue(chosenDate);
});

test('JSON-Sicherung exportieren und mit unveränderten Beitragsdaten importieren', async ({ page }) => {
  await createPost(page, { title: 'Sicherungstest', content: 'Umlaute: ÄÖÜ und Emojis 🌞', platform: 'TikTok', status: 'planned', date: '2026-12-20', time: '08:45' });
  await page.locator('#help-open:visible, #settings-open:visible, [data-open-help]:visible').first().click();
  const downloaded = page.waitForEvent('download');
  await page.locator('#export-data').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(backup.version).toBe(2);
  expect(backup.posts).toHaveLength(1);
  expect(backup.posts[0]).toMatchObject({ title: 'Sicherungstest', content: 'Umlaute: ÄÖÜ und Emojis 🌞', platform: 'TikTok', status: 'planned', date: '2026-12-20', time: '08:45' });
  await page.evaluate(key => localStorage.removeItem(key), STORAGE_KEY);
  await page.reload();
  await expect(page.locator('#count-planned')).toHaveText('0');
  page.once('dialog', dialog => dialog.accept());
  await importBackup(page, backup);
  await expect(card(page, 'Sicherungstest')).toBeVisible();
  await page.reload();
  await expect(card(page, 'Sicherungstest')).toBeVisible();
  await expect(page.locator('#count-planned')).toHaveText('1');
});

test('Import zeigt HTML als Text und verwirft eine ungültige Sicherung vollständig', async ({ page }) => {
  const title = '<img src=x onerror="window.__emcXss=1">';
  const content = '<script>window.__emcXss=2</script><a href="javascript:window.__emcXss=3">Klick</a>';
  const post = { id: 'safe-import', title, content, platform: 'Instagram', status: 'draft', date: '', time: '', image: '' };
  page.once('dialog', dialog => dialog.accept());
  await importBackup(page, { version: 1, posts: [post] });
  await expect(page.locator('#posts-list .post-card-title')).toHaveText(title);
  await expect(page.locator('#posts-list .post-card-body')).toHaveText(content);
  await expect(page.locator('#posts-list .post-card img, #posts-list .post-card script, #posts-list .post-card a')).toHaveCount(0);
  expect(await page.evaluate(() => window.__emcXss)).toBeUndefined();
  await importBackup(page, { version: 1, posts: [{ ...post, id: 'valid-first', title: 'Darf nicht teilweise gespeichert werden' }, { ...post, id: 'invalid-second', image: 'javascript:alert(1)' }] });
  await expect(page.locator('#toast')).toContainText(/ungültig|Bild/);
  await page.reload();
  await expect(page.locator('#posts-list .post-card')).toHaveCount(1);
  await expect(page.locator('#posts-list .post-card-title')).toHaveText(title);
  expect(await page.evaluate(() => window.__emcXss)).toBeUndefined();
});

test('Bild hinzufügen, nach Neuladen wieder öffnen und entfernen', async ({ page }) => {
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    context.fillStyle = '#7258f5';
    context.fillRect(0, 0, 32, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('#new-post').click();
  await page.locator('#post-title').fill('Bildbeitrag');
  await page.locator('#post-image').setInputFiles({ name: 'motiv.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('#image-preview')).toBeVisible();
  await expect(page.locator('#save-post')).toBeEnabled();
  await page.locator('#save-post').click();
  await page.reload();
  await view(page, 'posts');
  await expect(card(page, 'Bildbeitrag').locator('img')).toBeVisible();
  await card(page, 'Bildbeitrag').locator('.edit-post').click();
  await expect(page.locator('#image-preview')).toBeVisible();
  await page.locator('#remove-image').click();
  await page.locator('#save-post').click();
  await expect(card(page, 'Bildbeitrag').locator('img')).toHaveCount(0);
  await page.reload();
  await expect(card(page, 'Bildbeitrag').locator('img')).toHaveCount(0);
});

test('Navigation, Kalender und Beitragsdialog passen ohne horizontales Scrollen', async ({ page }) => {
  await expect(page.locator('#new-post')).toHaveAccessibleName('Neuer Beitrag');
  async function fitsViewport() {
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
  }
  await fitsViewport();
  await view(page, 'calendar');
  await fitsViewport();
  await expect(page.locator('.calendar-day')).toHaveCount(42);
  await view(page, 'posts');
  await fitsViewport();
  await page.locator('#new-post').click();
  await expect(page.locator('#save-post')).toBeVisible();
  const dialog = await page.locator('#post-dialog').boundingBox();
  const width = page.viewportSize().width;
  expect(dialog.x).toBeGreaterThanOrEqual(0);
  expect(dialog.x + dialog.width).toBeLessThanOrEqual(width + 1);
  await page.keyboard.press('Escape');
  await view(page, 'overview');
  await fitsViewport();
});

test('Installierter App-Shell startet offline und speichert neue Beiträge', async ({ page, context }) => {
  await createPost(page, { title: 'Vor der Reise' });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#count-draft')).toHaveText('1');
    await createPost(page, { title: 'Unterwegs ohne Internet', content: 'Diese Idee soll auch offline erhalten bleiben.' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await view(page, 'posts');
    await expect(card(page, 'Vor der Reise')).toBeVisible();
    await expect(card(page, 'Unterwegs ohne Internet')).toBeVisible();
    await expect(page.locator('#count-draft')).toHaveText('2');
  } finally {
    await context.setOffline(false);
  }
});

test('Kategorien erstellen, umbenennen und filtern; Löschen erhält die Beiträge ohne Kategorie', async ({ page }) => {
  const tips = await createCategory(page, 'Tipps & Wissen');
  const offers = await createCategory(page, 'Angebote', '#f26b3a');
  await createPost(page, { title: 'Unser bester Tipp', categoryId: tips.id });
  await createPost(page, { title: 'Neue Aktion', categoryId: offers.id });
  await createPost(page, { title: 'Noch unsortiert' });
  await view(page, 'posts');
  await expect(card(page, 'Unser bester Tipp')).toContainText('Tipps & Wissen');
  await page.locator('#filter-category').selectOption(tips.id);
  await expect(page.locator('#posts-list .post-card')).toHaveCount(1);
  await expect(card(page, 'Unser bester Tipp')).toBeVisible();
  await page.locator('#filter-category').selectOption('');

  await view(page, 'categories');
  await categoryCard(page, 'Tipps & Wissen').locator('.edit-category').click();
  await page.locator('#category-name').fill('Wissen aus der Praxis');
  await page.locator('#category-color').fill('#38b48b');
  await page.locator('#save-category').click();
  await page.reload();
  await expect(categoryCard(page, 'Wissen aus der Praxis')).toBeVisible();
  await view(page, 'posts');
  await expect(card(page, 'Unser bester Tipp')).toContainText('Wissen aus der Praxis');
  await card(page, 'Unser bester Tipp').locator('.edit-post').click();
  await expect(page.locator('#post-category')).toHaveValue(tips.id);
  await page.keyboard.press('Escape');

  await view(page, 'categories');
  await categoryCard(page, 'Wissen aus der Praxis').locator('.edit-category').click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#delete-category').click();
  await expect(page.locator('#category-dialog')).toBeVisible();
  expect((await workspace(page)).categories).toHaveLength(2);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-category').click();
  await expect(page.locator('#category-dialog')).not.toBeVisible();
  await page.reload();
  const saved = await workspace(page);
  expect(saved.categories).toEqual([{ ...offers }]);
  expect(saved.posts).toHaveLength(3);
  expect(saved.posts.find(post => post.title === 'Unser bester Tipp').categoryId).toBe('');
  expect(saved.posts.find(post => post.title === 'Neue Aktion').categoryId).toBe(offers.id);
  await view(page, 'posts');
  await page.locator('#filter-category').selectOption({ label: 'Ohne Kategorie' });
  await expect(page.locator('#posts-list .post-card')).toHaveCount(2);
  await expect(card(page, 'Unser bester Tipp')).toBeVisible();
  await expect(card(page, 'Noch unsortiert')).toBeVisible();
});

test('Doppelte Kategorien und fehlgeschlagenes Speichern verändern keine vorhandenen Zuordnungen', async ({ page }) => {
  const tips = await createCategory(page, 'Tipps');
  await createPost(page, { title: 'Vorhandener Tipp', categoryId: tips.id });
  await view(page, 'categories');
  await page.locator('#new-category').click();
  await page.locator('#category-name').fill('  TIPPS  ');
  await page.locator('#save-category').click();
  await expect(page.locator('#category-dialog')).toBeVisible();
  await expect(page.locator('#category-error')).toContainText(/bereits|eindeutig|vorhanden/i);
  expect((await workspace(page)).categories).toHaveLength(1);
  await page.keyboard.press('Escape');

  const before = await workspace(page);
  await categoryCard(page, 'Tipps').locator('.edit-category').click();
  await page.evaluate(key => {
    window.__emcOriginalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Speicher voll', 'QuotaExceededError');
      return window.__emcOriginalSetItem.call(this, name, value);
    };
  }, STORAGE_KEY);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-category').click();
  await expect(page.locator('#category-dialog')).toBeVisible();
  await expect(page.locator('#category-error')).toContainText(/Speichern|Speicher|voll/i);
  expect(await workspace(page)).toEqual(before);
  await page.evaluate(() => { Storage.prototype.setItem = window.__emcOriginalSetItem; });
  await page.keyboard.press('Escape');
  await view(page, 'posts');
  await expect(card(page, 'Vorhandener Tipp')).toContainText('Tipps');
  await page.reload();
  expect(await workspace(page)).toEqual(before);
});

test('Mehrere Websites zuordnen, bearbeiten und entfernen; unsichere Adressen werden abgewiesen', async ({ page }) => {
  const company = await createWebsite(page, 'Firmenwebsite', 'https://emc.example/');
  const blog = await createWebsite(page, 'Unser Blog', 'https://blog.emc.example/ideen');
  await expect(page.locator('#channels-list .channel-card')).toHaveCount(2);
  await createPost(page, { title: 'Neu auf unserer Website', platform: 'Website', channelId: company.id });
  await view(page, 'posts');
  await expect(card(page, 'Neu auf unserer Website')).toContainText('Firmenwebsite');
  await card(page, 'Neu auf unserer Website').locator('.edit-post').click();
  await expect(page.locator('#post-platform')).toHaveValue('Website');
  await expect(page.locator('#post-channel')).toHaveValue(company.id);
  await expect(page.locator('#post-channel option')).toHaveCount(3);
  await page.keyboard.press('Escape');

  await view(page, 'channels');
  await channelCard(page, 'Firmenwebsite').locator('.edit-website').click();
  await page.locator('#website-name').fill('EMC Website');
  await page.locator('#website-url').fill('https://www.emc.example/news');
  await page.locator('#save-website').click();
  await expect(channelCard(page, 'EMC Website').locator('a')).toHaveAttribute('href', 'https://www.emc.example/news');
  await page.reload();
  await expect(channelCard(page, 'EMC Website')).toBeVisible();

  await page.locator('#add-website').click();
  await page.locator('#website-name').fill('Ungültige Website');
  await page.locator('#website-url').fill('javascript:window.__emcWebsiteXss=1');
  await page.locator('#save-website').click();
  await expect(page.locator('#website-dialog')).toBeVisible();
  expect((await workspace(page)).websites).toHaveLength(2);
  expect(await page.evaluate(() => window.__emcWebsiteXss)).toBeUndefined();
  await page.locator('#website-url').fill('http://emc.example/');
  await page.locator('#save-website').click();
  await expect(page.locator('#website-error')).toContainText(/HTTPS/i);
  await page.keyboard.press('Escape');

  await channelCard(page, 'EMC Website').locator('.edit-website').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-website').click();
  await expect(page.locator('#website-dialog')).not.toBeVisible();
  await page.reload();
  expect((await workspace(page)).websites).toEqual([blog]);
  expect((await workspace(page)).posts[0]).toMatchObject({ title: 'Neu auf unserer Website', platform: 'Website', channelId: '' });
  await view(page, 'posts');
  await expect(card(page, 'Neu auf unserer Website')).toBeVisible();
});

test('Version-2-Sicherung erhält Kategorien und Website-Zuordnungen und verwirft unsichere Importe vollständig', async ({ page }) => {
  const category = await createCategory(page, 'Website-Neuigkeiten', '#38b48b');
  const website = await createWebsite(page, 'EMC Homepage', 'https://homepage.example/');
  await createPost(page, { title: 'Unsere neue Homepage', platform: 'Website', categoryId: category.id, channelId: website.id });
  const backup = await exportBackup(page);
  expect(backup.version).toBe(2);
  expect(backup.categories).toEqual([category]);
  expect(backup.websites).toEqual([website]);
  expect(backup.posts[0]).toMatchObject({ platform: 'Website', categoryId: category.id, channelId: website.id });
  await page.evaluate(key => localStorage.removeItem(key), STORAGE_KEY);
  await page.reload();
  page.once('dialog', dialog => dialog.accept());
  await importBackup(page, backup);
  await page.reload();
  const restored = await workspace(page);
  expect(restored).toEqual({ version: 2, posts: backup.posts, categories: backup.categories, websites: backup.websites });
  await view(page, 'posts');
  await expect(card(page, 'Unsere neue Homepage')).toContainText('Website-Neuigkeiten');
  await expect(card(page, 'Unsere neue Homepage')).toContainText('EMC Homepage');
  await importBackup(page, { ...backup, websites: [{ ...website, url: 'javascript:window.__emcWebsiteXss=1' }] });
  await expect(page.locator('#toast')).toContainText(/Adresse|Website|HTTPS|ungültig/i);
  expect(await workspace(page)).toEqual(restored);
  expect(await page.evaluate(() => window.__emcWebsiteXss)).toBeUndefined();
});

test('Vorhandene Version-1-Beiträge bleiben bei der Migration erhalten', async ({ page }) => {
  const existing = {
    id: 'legacy-post', title: 'Bestehender Entwurf', content: 'Dieser Text bleibt erhalten.',
    platform: 'LinkedIn', status: 'draft', date: '', time: '', image: '',
    createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-02T10:00:00.000Z',
  };
  await page.evaluate(({ key, post }) => localStorage.setItem(key, JSON.stringify([post])), { key: STORAGE_KEY, post: existing });
  await page.reload();
  await view(page, 'posts');
  await expect(card(page, 'Bestehender Entwurf')).toBeVisible();
  await createPost(page, { title: 'Nach der Migration' });
  const saved = await workspace(page);
  expect(saved.version).toBe(2);
  expect(saved.categories).toEqual([]);
  expect(saved.websites).toEqual([]);
  expect(saved.posts.find(post => post.id === 'legacy-post')).toEqual({ ...existing, categoryId: '', channelId: '' });
  await page.reload();
  await expect(card(page, 'Bestehender Entwurf')).toBeVisible();
  await expect(card(page, 'Nach der Migration')).toBeVisible();
});

test('Neue Verwaltungsansichten passen auf das Gerät und fehlende Anmeldedienste sind klar erkennbar', async ({ page }) => {
  await view(page, 'categories');
  await fitsViewport(page);
  await page.locator('#new-category').click();
  await fitsViewport(page);
  await page.keyboard.press('Escape');
  await view(page, 'channels');
  await fitsViewport(page);
  await expect(page.locator('#channel-connection-status')).toContainText(/kein|nicht|einricht/i);
  for (const provider of ['meta', 'tiktok', 'linkedin', 'youtube', 'pinterest', 'x']) {
    await expect(page.locator(`[data-connect-provider="${provider}"]`)).toBeDisabled();
  }
  await page.locator('#add-website').click();
  await fitsViewport(page);
  await page.keyboard.press('Escape');
  await page.locator('#connection-settings').click();
  await fitsViewport(page);
  await expect(page.locator('#connection-url')).toHaveAttribute('type', 'url');
});

test('Mehrere echte Konten derselben Plattform auswählen und sicher trennen; Sicherungen enthalten keine Anmeldedaten', async ({ page }) => {
  const baseUrl = 'https://channels.example.test';
  const expiresAt = '2099-01-01T00:00:00.000Z';
  const frontendOrigin = new URL(page.url()).origin;
  const accounts = [
    { id: 'instagram-brand-a', platform: 'Instagram', name: 'EMC Marke A', accountId: 'brand-a', handle: 'emc_marke_a', url: 'https://www.instagram.com/emc_marke_a/' },
    { id: 'instagram-brand-b', platform: 'Instagram', name: 'EMC Marke B', accountId: 'brand-b', handle: 'emc_marke_b', url: 'https://www.instagram.com/emc_marke_b/' },
    { id: 'facebook-brand-a', platform: 'Facebook', name: 'EMC Facebook', accountId: 'facebook-a', handle: '', url: 'https://www.facebook.com/emc.brand/' },
  ].map(account => ({ ...account, provider: 'meta', connectedAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z' }));
  let connected = [...accounts];
  const authenticatedRequests = [];
  let sessionRequests = 0;
  await page.route(`${baseUrl}/**`, async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const headers = {
      'access-control-allow-origin': frontendOrigin,
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'content-type': 'application/json',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (pathname === '/api/config') {
      return route.fulfill({ status: 200, headers, body: JSON.stringify({
        providers: [{ id: 'meta', name: 'Facebook & Instagram', configured: true, authorizationReady: true, platforms: ['Facebook', 'Instagram'], scopes: [] }],
        callbackBaseUrl: baseUrl, frontendOrigin,
      }) });
    }
    if (pathname === '/api/session' && request.method() === 'POST') {
      sessionRequests += 1;
      return route.fulfill({ status: 200, headers, body: JSON.stringify({ sessionToken: 'own-session-test', expiresAt }) });
    }
    if (pathname === '/api/channels' && request.method() === 'GET') {
      authenticatedRequests.push({ method: request.method(), authorization: request.headers().authorization });
      return route.fulfill({ status: 200, headers, body: JSON.stringify({
        channels: connected.map(account => ({ ...account, accessToken: 'provider-access-token-private', refreshToken: 'provider-refresh-token-private' })), expiresAt,
      }) });
    }
    if (pathname.startsWith('/api/channels/') && request.method() === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/channels/'.length));
      authenticatedRequests.push({ method: request.method(), authorization: request.headers().authorization, id });
      connected = connected.filter(account => account.id !== id);
      return route.fulfill({ status: 200, headers, body: JSON.stringify({ removed: true, revoked: false }) });
    }
    return route.fulfill({ status: 404, headers, body: JSON.stringify({ error: 'Unbekannte Testadresse' }) });
  });

  await view(page, 'channels');
  await page.locator('#connection-settings').click();
  await page.locator('#connection-url').fill(baseUrl);
  await page.locator('#save-connection').click();
  await expect(page.locator('#connection-dialog')).not.toBeVisible();
  await expect(page.locator('#channels-list .channel-card')).toHaveCount(3);
  await expect(page.locator('#connect-meta')).toBeEnabled();
  await expect(page.locator('#connect-tiktok')).toBeDisabled();
  expect(sessionRequests).toBe(1);

  await createPost(page, { title: 'Content für Marke A', channelId: accounts[0].id });
  await createPost(page, { title: 'Content für Marke B', channelId: accounts[1].id });
  await view(page, 'posts');
  await expect(card(page, 'Content für Marke A')).toContainText('EMC Marke A');
  await expect(card(page, 'Content für Marke B')).toContainText('EMC Marke B');
  await card(page, 'Content für Marke B').locator('.edit-post').click();
  await expect(page.locator('#post-channel')).toHaveValue(accounts[1].id);
  await expect(page.locator('#post-channel option')).toHaveCount(3);
  await page.locator('#post-platform').selectOption('Facebook');
  await expect(page.locator('#post-channel')).toHaveValue('');
  await expect(page.locator('#post-channel option')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.locator('#filter-channel').selectOption(accounts[1].id);
  await expect(page.locator('#posts-list .post-card')).toHaveCount(1);
  await expect(card(page, 'Content für Marke B')).toBeVisible();
  await page.locator('#filter-channel').selectOption('');

  const backup = await exportBackup(page);
  const exported = JSON.stringify(backup);
  for (const secret of ['own-session-test', 'provider-access-token-private', 'provider-refresh-token-private', baseUrl]) expect(exported).not.toContain(secret);
  expect(backup.posts).toHaveLength(2);
  expect(backup.posts.map(post => post.channelId).sort()).toEqual([accounts[0].id, accounts[1].id].sort());
  expect(await page.evaluate(() => Object.values(localStorage).some(value => /provider-access-token-private|provider-refresh-token-private/.test(value)))).toBe(false);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('emc-channel-session-v1')))).toMatchObject({ baseUrl, token: 'own-session-test', expiresAt });
  await page.keyboard.press('Escape');

  await view(page, 'channels');
  page.once('dialog', dialog => dialog.accept());
  await channelCard(page, 'EMC Marke A').locator('.disconnect-channel').click();
  await expect(page.locator('#channels-list .channel-card')).toHaveCount(2);
  expect(authenticatedRequests.some(request => request.method === 'DELETE' && request.id === accounts[0].id)).toBe(true);
  expect(authenticatedRequests.every(request => request.authorization === 'Bearer own-session-test')).toBe(true);
  expect((await workspace(page)).posts.find(post => post.title === 'Content für Marke A').channelId).toBe('');
  expect((await workspace(page)).posts.find(post => post.title === 'Content für Marke B').channelId).toBe(accounts[1].id);
  await page.reload();
  await view(page, 'posts');
  await expect(card(page, 'Content für Marke A')).toBeVisible();
  await expect(card(page, 'Content für Marke B')).toContainText('EMC Marke B');
});
