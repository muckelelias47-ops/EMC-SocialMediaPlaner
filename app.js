import { PLATFORMS, loadPosts, savePosts, validatePost, importPosts, calendarDays, formatDate, uid } from './lib.js';

const $ = (id) => document.getElementById(id);
const statusLabels = { draft: 'Entwurf', planned: 'Geplant', published: 'Veröffentlicht' };
const state = { posts: [], view: 'overview', month: new Date(), selectedDate: localDate(new Date()), image: '', imagePending: false, storageBlocked: false };
state.month = new Date(state.month.getFullYear(), state.month.getMonth(), 1);
let toastTimer;
let imageSequence = 0;
let installPrompt = null;
let storageBanner = null;

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorMessage(error, fallback = 'Das hat leider nicht funktioniert. Bitte versuche es erneut.') {
  return error instanceof Error && error.message ? error.message : fallback;
}

function toast(message, isError = false) {
  const node = $('toast');
  if (!node) return;
  clearTimeout(toastTimer);
  node.textContent = message;
  node.classList.toggle('is-error', isError);
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 10000 : 4500);
}

function showFormError(message) {
  $('form-error').textContent = message;
  $('form-error').hidden = !message;
}

function showStorageWarning(message) {
  if (!storageBanner) {
    storageBanner = element('div', 'storage-warning');
    storageBanner.setAttribute('role', 'alert');
    (document.querySelector('main') || document.body).prepend(storageBanner);
  }
  storageBanner.textContent = `${message} Deine vorhandenen Daten werden nicht überschrieben. Du kannst sie unter „Arbeitsbereich“ exportieren und eine Sicherung importieren.`;
}

function commitPosts(posts, { recover = false } = {}) {
  if (state.storageBlocked && !recover) {
    throw new Error('Die gespeicherten Daten konnten nicht gelesen werden. Bitte sichere sie unter „Arbeitsbereich“ und importiere anschließend eine gültige Sicherung.');
  }
  savePosts(posts);
  state.posts = posts;
  if (recover) {
    state.storageBlocked = false;
    storageBanner?.remove();
    storageBanner = null;
  }
  render();
}

function filteredPosts() {
  const search = $('search').value.trim().toLocaleLowerCase('de');
  const platform = $('filter-platform').value;
  const status = $('filter-status').value;
  return state.posts.filter((post) => (!platform || post.platform === platform) && (!status || post.status === status) && (!search || `${post.title} ${post.content} ${post.platform}`.toLocaleLowerCase('de').includes(search)));
}

function chronological(posts) {
  return [...posts].sort((a, b) => {
    const aDate = a.date ? `${a.date}T${a.time || '00:00'}` : '9999';
    const bDate = b.date ? `${b.date}T${b.time || '00:00'}` : '9999';
    return aDate.localeCompare(bDate) || b.updatedAt.localeCompare(a.updatedAt);
  });
}

function postCard(post) {
  const card = element('article', 'post-card');
  card.dataset.postId = post.id;
  const top = element('div', 'post-card-top');
  const platform = element('span', 'platform-badge', post.platform);
  platform.dataset.platform = post.platform.toLowerCase();
  const status = element('span', 'status-badge', statusLabels[post.status]);
  status.dataset.status = post.status;
  top.append(platform, status);
  card.append(top, element('h3', 'post-card-title', post.title));
  if (post.content) card.append(element('p', 'post-card-body', post.content));
  if (post.image) {
    const image = element('img', 'post-card-image');
    image.src = post.image;
    image.alt = `Bild zum Beitrag „${post.title}“`;
    image.loading = 'lazy';
    card.append(image);
  }
  const footer = element('div', 'post-card-footer');
  const date = element('span', 'post-date', post.date ? `${formatDate(post.date)}${post.time ? ` · ${post.time} Uhr` : ''}` : 'Noch kein Termin');
  const actions = element('div', 'post-actions');
  const edit = element('button', 'button icon-button edit-post');
  edit.type = 'button';
  edit.title = 'Bearbeiten';
  edit.setAttribute('aria-label', `Beitrag „${post.title}“ bearbeiten`);
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.classList.add('icon');
  icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#icon-edit');
  icon.append(use);
  edit.append(icon);
  edit.addEventListener('click', () => openEditor(post));
  actions.append(edit);
  footer.append(date, actions);
  card.append(footer);
  return card;
}

function renderPosts() {
  const filtered = filteredPosts();
  const all = chronological(filtered);
  $('posts-list').replaceChildren(...all.map(postCard));
  $('posts-empty').hidden = all.length !== 0;
  const upcoming = chronological(filtered.filter((post) => post.status === 'planned'));
  const overview = upcoming.length ? upcoming.slice(0, 6) : chronological(filtered.filter((post) => post.status === 'draft')).slice(0, 6);
  $('overview-posts').replaceChildren(...overview.map(postCard));
  $('overview-empty').hidden = overview.length !== 0;
  for (const status of ['planned', 'draft', 'published']) {
    $(`count-${status}`).textContent = String(state.posts.filter((post) => post.status === status).length);
  }
}

function renderCalendar() {
  const year = state.month.getFullYear();
  const month = state.month.getMonth();
  $('calendar-title').textContent = state.month.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  const filtered = filteredPosts();
  const days = calendarDays(year, month).map((day) => {
    const date = new Date(`${day.date}T12:00:00`);
    const posts = chronological(filtered.filter((post) => post.date === day.date));
    const button = element('button', 'calendar-day');
    button.type = 'button';
    button.dataset.outside = String(!day.inMonth);
    button.dataset.date = day.date;
    button.classList.toggle('is-today', day.date === localDate(new Date()));
    button.classList.toggle('is-selected', day.date === state.selectedDate);
    button.setAttribute('aria-pressed', String(day.date === state.selectedDate));
    button.setAttribute('aria-label', `${date.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${posts.length} ${posts.length === 1 ? 'Beitrag' : 'Beiträge'}`);
    button.append(element('span', 'calendar-day-number', String(date.getDate())));
    for (const post of posts.slice(0, 2)) {
      const event = element('span', 'calendar-event', post.title);
      event.dataset.platform = post.platform.toLowerCase();
      event.dataset.status = post.status;
      event.title = `${post.platform}: ${post.title}${post.time ? ` · ${post.time} Uhr` : ''}`;
      button.append(event);
    }
    if (posts.length > 2) button.append(element('span', 'calendar-more', `+${posts.length - 2} weitere`));
    button.addEventListener('click', () => {
      state.selectedDate = day.date;
      if (!day.inMonth) state.month = new Date(date.getFullYear(), date.getMonth(), 1);
      renderCalendar();
      $('calendar-grid').querySelector(`[data-date="${day.date}"]`)?.focus();
    });
    return button;
  });
  $('calendar-grid').replaceChildren(...days);
  $('calendar-selected-title').textContent = new Date(`${state.selectedDate}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  const selected = chronological(filtered.filter((post) => post.date === state.selectedDate));
  if (selected.length) {
    $('calendar-selected-list').replaceChildren(...selected.map(postCard));
  } else {
    const empty = element('div', 'selected-day-empty');
    empty.append(element('p', '', 'Für diesen Tag gibt es noch keine passenden Beiträge.'));
    const button = element('button', 'button button-secondary', 'Beitrag für diesen Tag erstellen');
    button.type = 'button';
    button.addEventListener('click', () => openEditor(null, state.selectedDate));
    empty.append(button);
    $('calendar-selected-list').replaceChildren(empty);
  }
}

function render() {
  renderPosts();
  renderCalendar();
}

function switchView(view, updateHash = true) {
  if (!['overview', 'calendar', 'posts'].includes(view)) view = 'overview';
  state.view = view;
  for (const panel of document.querySelectorAll('[data-view-panel]')) {
    panel.hidden = panel.id !== `view-${view}`;
  }
  for (const button of document.querySelectorAll('[data-view]')) {
    const current = button.dataset.view === view;
    button.classList.toggle('is-active', current);
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (updateHash) history.replaceState(null, '', `#${view}`);
}

function previewImage() {
  const hasImage = Boolean(state.image);
  $('image-preview-wrap').hidden = !hasImage;
  $('image-preview').hidden = !hasImage;
  if (hasImage) $('image-preview').src = state.image;
  else $('image-preview').removeAttribute('src');
  $('remove-image').hidden = !hasImage;
}

function updateScheduleRequired() {
  const required = $('post-status').value === 'planned';
  $('post-date').required = required;
  $('post-time').required = required;
}

function openEditor(post = null, date = null) {
  imageSequence += 1;
  state.imagePending = false;
  $('save-post').disabled = false;
  $('post-form').reset();
  $('post-id').value = post?.id || '';
  $('post-title').value = post?.title || '';
  $('post-body').value = post?.content || '';
  $('post-platform').value = post?.platform || PLATFORMS[0];
  $('post-status').value = post?.status || 'draft';
  $('post-date').value = post ? post.date || '' : date || localDate(new Date());
  $('post-time').value = post ? post.time || '' : '10:00';
  $('post-image').value = '';
  state.image = post?.image || '';
  $('post-dialog-title').textContent = post ? 'Beitrag bearbeiten' : 'Neuer Beitrag';
  $('delete-post').hidden = !post;
  showFormError('');
  previewImage();
  updateScheduleRequired();
  $('post-dialog').showModal();
  $('post-title').focus();
}

async function compressImage(file) {
  if (file.size > 10 * 1024 * 1024) throw new Error('Das Bild ist zu groß. Bitte wähle ein Bild mit höchstens 10 MB.');
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
    throw new Error('Bitte wähle ein JPG-, PNG-, WebP- oder GIF-Bild. HEIC-Bilder kannst du vorher als JPG exportieren.');
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Das Bild konnte nicht gelesen werden.');
    const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Dein Browser kann dieses Bild nicht verarbeiten.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch (error) {
    if (error instanceof Error && error.name === 'EncodingError') throw new Error('Das Bild konnte nicht gelesen werden. Bitte versuche ein anderes JPG- oder PNG-Bild.');
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportData() {
  try {
    if (state.storageBlocked) {
      const raw = localStorage.getItem('emc-social-planner-v1');
      if (!raw) throw new Error('Die vorhandenen Daten sind für diesen Browser nicht zugänglich.');
      download(raw, `emc-datenrettung-${localDate(new Date())}.json`);
      toast('Die vorhandenen Daten wurden als Datei gesichert.');
      return;
    }
    download(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), posts: state.posts }, null, 2), `emc-social-planer-${localDate(new Date())}.json`);
    toast('Deine Sicherung wurde heruntergeladen.');
  } catch (error) {
    toast(errorMessage(error), true);
  }
}

async function importData(file) {
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('Die Datei ist zu groß. Bitte importiere eine JSON-Sicherung mit höchstens 20 MB.');
    const posts = importPosts(await file.text());
    const replacesExisting = state.posts.length > 0 || state.storageBlocked;
    const prompt = replacesExisting
      ? `${posts.length} ${posts.length === 1 ? 'Beitrag' : 'Beiträge'} importieren? Alle bisher gespeicherten Beiträge in diesem Browser werden ersetzt. Sichere sie bei Bedarf zuerst über „Exportieren“.`
      : `${posts.length} ${posts.length === 1 ? 'Beitrag' : 'Beiträge'} aus dieser Sicherung importieren?`;
    if (!window.confirm(prompt)) return;
    commitPosts(posts, { recover: true });
    $('help-dialog').close();
    switchView('posts');
    toast(`${posts.length} ${posts.length === 1 ? 'Beitrag wurde' : 'Beiträge wurden'} importiert.`);
  } catch (error) {
    toast(errorMessage(error, 'Diese Sicherung konnte nicht importiert werden.'), true);
  } finally {
    $('import-data').value = '';
  }
}

function updateInstallButtons(available) {
  for (const id of ['install-app', 'install-sidebar']) {
    const button = $(id);
    if (!button) continue;
    if (id === 'install-sidebar') button.hidden = !available;
    if (id === 'install-app') {
      button.hidden = false;
      const icon = button.querySelector('svg');
      const label = document.createTextNode(available ? 'App jetzt installieren' : 'Installationsanleitung anzeigen');
      button.replaceChildren(...(icon ? [icon, label] : [label]));
    }
  }
}

async function installApp() {
  if (!installPrompt) {
    if (!$('help-dialog').open) $('help-dialog').showModal();
    $('install-app').focus();
    return;
  }
  try {
    const prompt = installPrompt;
    installPrompt = null;
    await prompt.prompt();
    const result = await prompt.userChoice;
    updateInstallButtons(false);
    if (result.outcome === 'accepted') toast('Die App wird installiert. Du kannst sie anschließend vom Startbildschirm öffnen.');
  } catch {
    updateInstallButtons(false);
    toast('Öffne „Arbeitsbereich“ für die Installationsanleitung.', true);
  }
}

function setupEvents() {
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => switchView(button.dataset.view));
  for (const button of document.querySelectorAll('#new-post, #new-post-empty, [data-action="new-post"]')) {
    button.addEventListener('click', () => openEditor(null, state.view === 'calendar' ? state.selectedDate : null));
  }
  for (const button of document.querySelectorAll('[data-close-dialog]')) {
    button.addEventListener('click', () => button.closest('dialog')?.close());
  }
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  }
  $('post-dialog').addEventListener('close', () => { imageSequence += 1; });
  for (const button of document.querySelectorAll('#help-open, #settings-open, [data-open-help]')) {
    button.addEventListener('click', () => $('help-dialog').showModal());
  }
  $('search').addEventListener('input', render);
  $('filter-platform').addEventListener('change', render);
  $('filter-status').addEventListener('change', render);
  $('calendar-prev').addEventListener('click', () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); renderCalendar(); });
  $('calendar-next').addEventListener('click', () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); renderCalendar(); });
  $('calendar-today').addEventListener('click', () => {
    const now = new Date();
    state.month = new Date(now.getFullYear(), now.getMonth(), 1);
    state.selectedDate = localDate(now);
    renderCalendar();
  });
  $('post-status').addEventListener('change', updateScheduleRequired);
  $('post-image').addEventListener('change', async () => {
    const file = $('post-image').files?.[0];
    if (!file) return;
    const sequence = ++imageSequence;
    state.imagePending = true;
    $('save-post').disabled = true;
    showFormError('');
    try {
      const data = await compressImage(file);
      if (sequence !== imageSequence) return;
      state.image = data;
      previewImage();
    } catch (error) {
      if (sequence === imageSequence) showFormError(errorMessage(error, 'Das Bild konnte nicht verarbeitet werden.'));
    } finally {
      if (sequence === imageSequence) {
        state.imagePending = false;
        $('save-post').disabled = false;
        $('post-image').value = '';
      }
    }
  });
  $('remove-image').addEventListener('click', () => {
    imageSequence += 1;
    state.imagePending = false;
    state.image = '';
    $('post-image').value = '';
    $('save-post').disabled = false;
    previewImage();
  });
  $('post-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.imagePending) return;
    try {
      const id = $('post-id').value;
      const existing = state.posts.find((post) => post.id === id);
      const now = new Date().toISOString();
      const post = validatePost({
        id: id || uid(), title: $('post-title').value, content: $('post-body').value,
        platform: $('post-platform').value, status: $('post-status').value,
        date: $('post-date').value, time: $('post-time').value, image: state.image,
        createdAt: existing?.createdAt || now, updatedAt: now,
      });
      const posts = existing ? state.posts.map((item) => item.id === id ? post : item) : [...state.posts, post];
      commitPosts(posts);
      $('post-dialog').close();
      toast(existing ? 'Dein Beitrag wurde aktualisiert.' : 'Dein Beitrag wurde gespeichert.');
    } catch (error) {
      showFormError(errorMessage(error, 'Der Beitrag konnte nicht gespeichert werden.'));
    }
  });
  $('delete-post').addEventListener('click', () => {
    const id = $('post-id').value;
    const post = state.posts.find((item) => item.id === id);
    if (!post || !window.confirm(`Beitrag „${post.title}“ endgültig löschen?`)) return;
    try {
      commitPosts(state.posts.filter((item) => item.id !== id));
      $('post-dialog').close();
      toast('Der Beitrag wurde gelöscht.');
    } catch (error) {
      showFormError(errorMessage(error));
    }
  });
  $('export-data').addEventListener('click', exportData);
  $('import-trigger').addEventListener('click', () => $('import-data').click());
  $('import-data').addEventListener('change', () => importData($('import-data').files?.[0]));
  for (const id of ['install-app', 'install-sidebar']) $(id)?.addEventListener('click', installApp);
  window.addEventListener('hashchange', () => switchView(location.hash.slice(1), false));
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    updateInstallButtons(true);
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; updateInstallButtons(false); toast('EMC ist installiert. Viel Freude beim Planen!'); });
  window.addEventListener('storage', (event) => {
    if (event.key && event.key !== 'emc-social-planner-v1') return;
    try {
      state.posts = loadPosts();
      state.storageBlocked = false;
      storageBanner?.remove();
      storageBanner = null;
      render();
      toast('Die Beiträge wurden aus einem anderen Fenster aktualisiert.');
    } catch (error) {
      state.storageBlocked = true;
      showStorageWarning(errorMessage(error));
    }
  });
}

function init() {
  for (const platform of PLATFORMS) {
    $('post-platform').append(new Option(platform, platform));
    $('filter-platform').append(new Option(platform, platform));
  }
  $('today-label').textContent = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  try {
    state.posts = loadPosts();
  } catch (error) {
    state.storageBlocked = true;
    showStorageWarning(errorMessage(error));
  }
  setupEvents();
  updateInstallButtons(false);
  switchView(location.hash.slice(1), false);
  render();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      toast('Die Offline-Funktion ist momentan nicht verfügbar. Du kannst die App weiterhin online nutzen.', true);
    });
  }
}

init();
