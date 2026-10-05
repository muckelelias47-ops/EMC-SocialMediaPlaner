import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const STORAGE_KEY = 'emc-social-planner-v1';

async function view(page, name) {
  await page.locator(`[data-view="${name}"]:visible`).first().click();
  await expect(page.locator(`#view-${name}`)).toBeVisible();
}

async function createPost(page, { title, content = '', platform = 'Instagram', status = 'draft', date = '', time = '' }) {
  await page.locator('#new-post').click();
  await expect(page.locator('#post-dialog')).toBeVisible();
  await page.locator('#post-title').fill(title);
  await page.locator('#post-body').fill(content);
  await page.locator('#post-platform').selectOption(platform);
  await page.locator('#post-status').selectOption(status);
  await page.locator('#post-date').fill(date);
  await page.locator('#post-time').fill(time);
  await page.locator('#save-post').click();
  await expect(page.locator('#post-dialog')).not.toBeVisible();
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
  expect(backup.version).toBe(1);
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
