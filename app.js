// ============================================================
// Ministerio de Alabanza Yahweh
// app.js — Versión completa con las 3 mejoras
// 1) Artistas y Bandas expandibles con lista de canciones
// 2) Visor embebido de letras (PDF/imagen/texto extraído)
// 3) Modo offline con cache automático
// ============================================================

const supa = typeof supabase !== 'undefined' && typeof SUPABASE_URL !== 'undefined' && typeof SUPABASE_PUBLISHABLE_KEY !== 'undefined'
  ? supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY) : null;

let authReady = false, currentUser = null;
const app = document.getElementById('app');
let view = 'inicio', search = '', editing = null, activeService = null, mobileMenu = false, notifyTimer;
let cloudProblem = '';
let isOnline = navigator.onLine;
let offlineMode = false;
let snapshotAvailable = false;
const OFFLINE_DB_NAME = 'alabanza-local-v3';

// --- IndexedDB para cache offline ---
let db;
const op = new Promise((resolve, reject) => {
  let r = indexedDB.open(OFFLINE_DB_NAME, 1);
  r.onupgradeneeded = () => {
    let d = r.result;
    if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('services')) d.createObjectStore('services', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('snapshots')) d.createObjectStore('snapshots', { keyPath: 'id' });
  };
  r.onsuccess = () => { db = r.result; resolve(); };
  r.onerror = () => reject(r.error);
});

// --- Estado ---
let songs = [], services = [], artists = [], categories = [], serviceSections = [];
let expandedArtists = new Set(); // artistas expandidos en la vista
let offlineFiles = new Set(); // paths de archivos cacheados
const uuid = () => crypto.randomUUID();

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? escapeHtml(u) : '';
const normalize = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

function tx(store, mode = 'readonly') { return db.transaction(store, mode).objectStore(store); }
function req(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }

// Los datos offline pertenecen a la cuenta que inició sesión en ESTE dispositivo.
function offlineKey(path) { return `${currentUser?.id || 'sin-usuario'}:${path}`; }
async function saveSnapshot() {
  if (!currentUser || offlineMode) return;
  await op;
  const snapshot = {
    id: currentUser.id, songs, services, artists, categories, serviceSections,
    savedAt: Date.now()
  };
  await req(tx('snapshots', 'readwrite').put(snapshot));
  snapshotAvailable = true;
}
async function loadSnapshot() {
  if (!currentUser) return false;
  await op;
  const snapshot = await req(tx('snapshots').get(currentUser.id));
  if (!snapshot) return false;
  songs = snapshot.songs || [];
  services = snapshot.services || [];
  artists = snapshot.artists || [];
  categories = snapshot.categories || [];
  serviceSections = snapshot.serviceSections || [];
  snapshotAvailable = true;
  await detectOfflineFiles();
  return true;
}
async function clearOfflineUser(uid) {
  await op;
  await req(tx('snapshots', 'readwrite').delete(uid));
  const store = tx('files', 'readwrite');
  const keys = await req(store.getAllKeys());
  await Promise.all(keys.filter(k => String(k).startsWith(uid + ':'))
    .map(k => req(tx('files', 'readwrite').delete(k))));
  offlineFiles.clear();
  snapshotAvailable = false;
}
function requireInternet() {
  if (offlineMode || !navigator.onLine) {
    toast('Sin internet: solo puedes consultar lo que guardaste. Conéctate para editar o subir.');
    return false;
  }
  return true;
}


// --- Detección de conexión ---
window.addEventListener('online', () => { isOnline = true; if (currentUser) refresh(); else render(); toast('🟢 Conexión restaurada'); });
window.addEventListener('offline', () => { isOnline = false; if (currentUser) refresh(); else render(); toast('🔴 Sin conexión'); });

// --- Helpers Supabase ---
function checked(result) { if (result.error) throw result.error; return result.data; }
function storedFile(path) { if (!path) return null; return { id: path, name: decodeURIComponent(path.split('/').slice(1).join('/')) || 'Archivo', path }; }

// --- Conversión Supabase <-> App ---
function asSong(row) {
  return {
    id: row.id,
    name: row.nombre,
    category: row.categoria,
    artistId: row.artista_id || null,
    tone: row.tonalidad || '',
    contenidoTexto: row.contenido_texto || '',
    links: {
      youtube: row.youtube_url || '',
      spotify: row.spotify_url || '',
      facebook: row.facebook_url || ''
    },
    files: {
      pdf: storedFile(row.pdf_url),
      word: storedFile(row.word_url),
      chords: storedFile(row.acordes_pdf_url),
      image: storedFile(row.acordes_imagen_url)
    }
  };
}

function asSongRow(s) {
  return {
    id: s.id,
    nombre: s.name,
    categoria: s.category,
    artista_id: s.artistId || null,
    tonalidad: s.tone || null,
    contenido_texto: s.contenidoTexto || null,
    pdf_url: s.files?.pdf?.path || null,
    word_url: s.files?.word?.path || null,
    acordes_pdf_url: s.files?.chords?.path || null,
    acordes_imagen_url: s.files?.image?.path || null,
    youtube_url: s.links?.youtube || null,
    spotify_url: s.links?.spotify || null,
    facebook_url: s.links?.facebook || null,
    creado_por: currentUser.id
  };
}

// --- Carga desde Supabase ---
async function fetchCloud() {
  const catRows = checked(await supa.from('categorias').select('*').order('orden', { ascending: true }));
  categories = catRows;

  const secRows = checked(await supa.from('secciones_servicio').select('*').order('orden', { ascending: true }));
  serviceSections = secRows;

  const artistRows = checked(await supa.from('artistas').select('id, nombre').order('nombre', { ascending: true }));
  artists = artistRows;

  const songRows = checked(await supa.from('canciones').select('*').order('nombre', { ascending: true }).limit(1000));
  songs = songRows.map(asSong);

  const serviceRows = checked(await supa.from('servicios').select('*').order('fecha', { ascending: false }).limit(500));
  const itemRows = checked(await supa.from('repertorio').select('*').order('orden', { ascending: true }).limit(5000));

  services = serviceRows.map(r => ({
    id: r.id,
    name: r.nombre,
    date: r.fecha || '',
    description: r.descripcion || '',
    type: r.tipo_servicio || 'normal',
    items: itemRows
      .filter(i => i.servicio_id === r.id)
      .map(i => ({ id: i.id, songId: i.cancion_id, section: i.seccion, tone: i.tonalidad || '' }))
  }));

  // Detectar archivos en cache offline
  await detectOfflineFiles();
  await saveSnapshot();
}

async function detectOfflineFiles() {
  offlineFiles = new Set();
  try {
    await op;
    const all = await req(tx('files').getAllKeys());
    all.filter(k => String(k).startsWith(currentUser?.id + ':'))
      .forEach(k => offlineFiles.add(String(k).slice(currentUser.id.length + 1)));
  } catch (e) { console.warn('No se pudo leer cache offline', e); }
}

async function refresh() {
  if (!currentUser) { render(); return; }
  if (!navigator.onLine) {
    offlineMode = true;
    cloudProblem = '';
    try {
      if (!await loadSnapshot()) cloudProblem = 'No hay biblioteca guardada para esta cuenta. Conéctate, inicia sesión y sincroniza primero.';
    } catch (e) { cloudProblem = 'No se pudo leer la biblioteca sin conexión: ' + e.message; }
    render();
    return;
  }
  try {
    offlineMode = false;
    await fetchCloud();
    cloudProblem = '';
  } catch (e) {
    console.error('Falló actualización de nube', e);
    // Si Supabase está temporalmente inaccesible, conserva las últimas canciones.
    try {
      if (await loadSnapshot()) {
        offlineMode = true;
        cloudProblem = '';
        toast('No se pudo conectar. Mostrando biblioteca guardada.');
      } else cloudProblem = e.message;
    } catch (_) { cloudProblem = e.message; }
  }
  render();
}

// --- Guardar / Eliminar ---
async function put(store, val) {
  if (store === 'songs') {
    checked(await supa.from('canciones').upsert(asSongRow(val)));
    return;
  }
  if (store === 'services') {
    checked(await supa.from('servicios').upsert({
      id: val.id,
      nombre: val.name,
      fecha: val.date || new Date().toLocaleDateString('en-CA'),
      descripcion: val.description || '',
      tipo_servicio: val.type || 'normal',
      creado_por: currentUser.id
    }));
    const existing = checked(await supa.from('repertorio').select('id').eq('servicio_id', val.id));
    const ids = new Set(val.items.map(i => i.id));
    const removed = existing.filter(i => !ids.has(i.id)).map(i => i.id);
    if (removed.length) checked(await supa.from('repertorio').delete().in('id', removed));
    if (val.items.length) {
      checked(await supa.from('repertorio').upsert(val.items.map((i, index) => ({
        id: i.id,
        servicio_id: val.id,
        cancion_id: i.songId,
        seccion: i.section,
        tonalidad: i.tone || null,
        orden: index
      }))));
    }
    return;
  }
  if (store === 'artists') {
    checked(await supa.from('artistas').upsert({ id: val.id, nombre: val.name }));
    return;
  }
  throw Error('Store no soportado: ' + store);
}

async function del(store, id) {
  if (store === 'songs') { checked(await supa.from('canciones').delete().eq('id', id)); return; }
  if (store === 'services') { checked(await supa.from('servicios').delete().eq('id', id)); return; }
  if (store === 'files') {
    checked(await supa.storage.from('canciones').remove([id]));
    try { await op; await req(tx('files', 'readwrite').delete(offlineKey(id))); } catch (e) {}
    return;
  }
  if (store === 'artists') { checked(await supa.from('artistas').delete().eq('id', id)); return; }
}

// --- Extracción de texto de PDF / Word ---
async function extractPdfText(file) {
  try {
    if (typeof pdfjsLib === 'undefined') return '';
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    let text = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(it => it.str).join(' ') + '\n\n';
    }
    return text.trim();
  } catch (e) {
    console.warn('No se pudo extraer texto del PDF', e);
    return '';
  }
}

async function extractWordText(file) {
  try {
    if (typeof mammoth === 'undefined') return '';
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return (result.value || '').trim();
  } catch (e) {
    console.warn('No se pudo extraer texto del Word', e);
    return '';
  }
}

async function extractText(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'pdf') return extractPdfText(file);
  if (['doc', 'docx'].includes(ext)) return extractWordText(file);
  return '';
}

// --- Subir archivos ---
async function uploadSongFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  const allowed = ['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'webp'];
  if (!allowed.includes(extension)) throw Error('Tipo de archivo no permitido: ' + extension);
  if (file.size > 25 * 1024 * 1024) throw Error('El archivo supera el límite de 25 MB');
  const path = uuid() + '/' + encodeURIComponent(file.name.replace(/[^a-zA-Z0-9_.-]/g, '_'));
  checked(await supa.storage.from('canciones').upload(path, file, { upsert: false, contentType: file.type || undefined }));
  return { id: path, path, name: file.name };
}

// --- Cache offline: guardar archivo ---
async function cacheFile(path, blob) {
  if (!currentUser) return;
  await op;
  await req(tx('files', 'readwrite').put({ id: offlineKey(path), blob, cachedAt: Date.now() }));
  offlineFiles.add(path);
}

// Primero utiliza el archivo privado guardado para esta cuenta en el dispositivo.
async function getFileBlob(path) {
  if (!currentUser) throw Error('Inicia sesión antes de abrir documentos.');
  await op;
  const cached = await req(tx('files').get(offlineKey(path)));
  if (cached?.blob) return cached.blob;
  if (!navigator.onLine || offlineMode) throw Error('Este archivo aún no fue guardado para usar sin internet.');
  const signed = checked(await supa.storage.from('canciones').createSignedUrl(path, 300));
  const res = await fetch(signed.signedUrl);
  if (!res.ok) throw Error('No se pudo obtener el archivo: HTTP ' + res.status);
  const blob = await res.blob();
  await cacheFile(path, blob);
  return blob;
}

// --- PASO 39: Encabezados y letras escritas manualmente ---
const LYRIC_HEADINGS = new Map([
  ['INTRO','intro'], ['INTRODUCCION','intro'],
  ['CORO','coro'], ['ESTRIBILLO','coro'],
  ['INSTRUMENTAL','instrumental'], ['INTERLUDIO','instrumental'],
  ['VERSO','verso'], ['ESTROFA','verso'], ['PUENTE','puente'],
  ['PRE CORO','puente'], ['PRECORO','puente'], ['FINAL','final']
]);
function lyricHeadingClass(text) {
  const key = normalize(text).replace(/\s*[:：.\-–]\s*$/, '').replace(/\s+/g, ' ').toUpperCase();
  return LYRIC_HEADINGS.get(key) || '';
}
function lyricLinesHtml(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n').map(line => {
    const kind = lyricHeadingClass(line);
    return `<p class="lyric-line ${kind ? 'lyric-part lyric-' + kind : ''}">${escapeHtml(line) || '&nbsp;'}</p>`;
  }).join('');
}
// Colorea únicamente los párrafos que son títulos de sección completos.
function markWordHeadings(container) {
  container.querySelectorAll('p').forEach(p => {
    const kind = lyricHeadingClass(p.textContent);
    if (kind && !p.querySelector('img')) p.classList.add('lyric-part', 'lyric-' + kind);
  });
}
function manualLyricsViewer(song) {
  const s = songs.find(x => x.id === song);
  if (!s?.contenidoTexto?.trim()) { toast('Esta canción todavía no tiene una letra escrita.'); return; }
  let size = 19, dark = false;
  modal(s.name + ' — Letra', `
    <div class="row" style="margin-bottom:12px">
      <button class="btn secondary small" id="manual-less">A−</button>
      <button class="btn secondary small" id="manual-more">A+</button>
      <button class="btn secondary small" id="manual-dark">🌙 Modo oscuro</button>
      <button class="btn secondary small" id="manual-full">⛶ Pantalla completa</button>
    </div>
    <div class="manual-lyric-page" id="manual-lyric-page">
      <div class="lyric-doves"><span aria-hidden="true">🕊️</span><span aria-hidden="true">🕊️</span></div>
      <h2 class="lyric-title">${escapeHtml(s.name)}</h2>
      <div class="lyric-body">${lyricLinesHtml(s.contenidoTexto)}</div>
    </div>`, { wide: true });
  const overlay = document.getElementById('overlay');
  const page = overlay.querySelector('#manual-lyric-page');
  const update = () => { page.style.fontSize = size + 'px'; page.classList.toggle('dark', dark); };
  overlay.querySelector('#manual-less').onclick = () => { size = Math.max(12,size-2); update(); };
  overlay.querySelector('#manual-more').onclick = () => { size = Math.min(36,size+2); update(); };
  overlay.querySelector('#manual-dark').onclick = () => { dark = !dark; update(); };
  overlay.querySelector('#manual-full').onclick = async () => {
    try { if (!document.fullscreenElement) await page.requestFullscreen(); else await document.exitFullscreen(); }
    catch (e) { toast('Pantalla completa no disponible en este dispositivo.'); }
  };
  update();
}
function updateLyricsPreview() {
  const field = document.getElementById('song-manual-text');
  const title = document.querySelector('#song-form [name="name"]');
  const preview = document.getElementById('song-manual-preview');
  if (!preview || !field) return;
  preview.innerHTML = `<div class="lyric-doves"><span>🕊️</span><span>🕊️</span></div>
    <h3 class="lyric-title">${escapeHtml(title?.value || 'NOMBRE DE LA CANCIÓN')}</h3>
    <div class="lyric-body">${lyricLinesHtml(field.value)}</div>`;
}

// --- UI helpers ---

 // --- PASO 27: Biblioteca completa sin internet ---

let offlineDownloadRunning = false;
let offlineDownloadCancel = false;

function libraryFilePaths() {
  return [...new Set(
    songs.flatMap(song =>
      Object.values(song.files || {})
        .filter(file => file && file.path)
        .map(file => file.path)
    )
  )];
}

function offlineProgressSummary() {
  const paths = libraryFilePaths();
  const saved = paths.filter(path => offlineFiles.has(path)).length;

  return {
    total: paths.length,
    saved,
    pending: paths.length - saved
  };
}

async function prepareOfflineLibrary() {
  if (offlineDownloadRunning) return;
  if (!currentUser || !requireInternet()) return;

  await op;
  await detectOfflineFiles();

  const paths = libraryFilePaths();
  const missing = paths.filter(path => !offlineFiles.has(path));

  if (!paths.length) {
    toast('La biblioteca no tiene documentos para descargar.');
    return;
  }

  if (!missing.length) {
    toast('Todos los documentos ya están guardados.');
    render();
    return;
  }

  offlineDownloadRunning = true;
  offlineDownloadCancel = false;

  const dialog = document.createElement('div');
  dialog.className = 'modal-bg';
  dialog.id = 'offline-download-dialog';

  dialog.innerHTML = `
    <section class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Guardar biblioteca sin internet"
      style="width:min(540px,100%)">

      <h2 style="margin-top:0">
        ⬇ Preparar biblioteca sin internet
      </h2>

      <p class="muted">
        Descargando documentos al almacenamiento
        de este dispositivo. Mantén esta página
        abierta y el WiFi conectado.
      </p>

      <p id="offline-download-status"
        role="status"
        aria-live="polite">
        Preparando descarga…
      </p>

      <progress
        id="offline-download-progress"
        max="${missing.length}"
        value="0"
        style="width:100%;height:17px">
      </progress>

      <p class="muted compact"
        id="offline-download-details">
      </p>

      <div class="row between"
        style="margin-top:18px">

        <button type="button"
          class="btn secondary"
          id="offline-download-cancel">
          Detener
        </button>

        <button type="button"
          class="btn green"
          id="offline-download-done"
          disabled>
          Cerrar
        </button>
      </div>
    </section>
  `;

  document.body.append(dialog);

  const status = dialog.querySelector(
    '#offline-download-status'
  );

  const details = dialog.querySelector(
    '#offline-download-details'
  );

  const progress = dialog.querySelector(
    '#offline-download-progress'
  );

  const cancel = dialog.querySelector(
    '#offline-download-cancel'
  );

  const done = dialog.querySelector(
    '#offline-download-done'
  );

  cancel.addEventListener('click', () => {
    offlineDownloadCancel = true;
    cancel.disabled = true;
    cancel.textContent = 'Deteniendo…';
  });

  done.addEventListener('click', () => {
    dialog.remove();
  });

  let saved = 0;
  let failures = 0;
  let attempted = 0;

  for (const path of missing) {
    if (offlineDownloadCancel) break;

    if (!navigator.onLine) {
      status.textContent =
        'Se perdió la conexión. Descarga detenida.';
      break;
    }

    const filename = decodeURIComponent(
      path.split('/').pop() || path
    );

    status.textContent =
      `Guardando ${attempted + 1} de ${missing.length}: ${filename}`;

    try {
      // Obtiene el archivo y lo guarda en IndexedDB.
      await getFileBlob(path);
      saved++;

    } catch (error) {
      failures++;

      console.warn(
        'Error preparando documento offline:',
        filename,
        error
      );
    }

    attempted++;
    progress.value = attempted;

    details.textContent =
      `${saved} guardados · ` +
      `${failures} errores · ` +
      `${missing.length - attempted} restantes`;
  }

  offlineDownloadRunning = false;
  cancel.hidden = true;
  done.disabled = false;

  await detectOfflineFiles();

  const summary = offlineProgressSummary();

  status.textContent = offlineDownloadCancel
    ? 'Descarga detenida. Puedes continuar después.'
    : summary.pending === 0
      ? '¡Biblioteca preparada! Todos los documentos están disponibles.'
      : `Proceso terminado. Quedan ${summary.pending} documentos pendientes.`;

  details.textContent =
    `${summary.saved} de ${summary.total} documentos guardados · ` +
    `${failures} errores en esta descarga`;

  render();
}

function toast(m) {
  let old = document.querySelector('.notify');
  if (old) old.remove();
  let div = document.createElement('div');
  div.className = 'notify';
  div.textContent = m;
  document.body.append(div);
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => div.remove(), 3200);
}

function nav(v) { view = v; search = ''; mobileMenu = false; render(); }

// --- Categorías helpers ---
function catByName(name) { return categories.find(c => c.nombre === name); }
function catColor(name) { return catByName(name)?.color || '#e0efff'; }
function catIcon(name) { return catByName(name)?.icono || '♫'; }

// --- Artistas helpers ---
function artistName(id) { return artists.find(a => a.id === id)?.nombre || ''; }
function artistOptions(selectedId, includeEmpty = true) {
  const opts = artists.map(a => `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${escapeHtml(a.nombre)}</option>`).join('');
  return (includeEmpty ? `<option value="">— Sin artista —</option>` : '') + opts;
}

// --- Tonalidades ---
const tones = ['C','C#','Db','D','Eb','E','F','F#','Gb','G','Ab','A','Bb','B','Cm','C#m','Dm','Ebm','Em','Fm','F#m','Gm','G#m','Am','Bbm','Bm'];
function toneOptions(selected) {
  return `<option value="">Tono</option>` + tones.map(t => `<option value="${t}" ${t === selected ? 'selected' : ''}>${t}</option>`).join('');
}

// --- Header / Shell ---
function header(title, sub) {
  const pill = isOnline && !offlineMode
    ? '<span class="pill">● En línea</span>'
    : '<span class="pill" style="background:#fee7e9;color:#b42332">● Sin conexión</span>';
  return `<div class="topbar"><div class="row"><button class="btn secondary menu-btn" data-action="menu">☰</button><div><h1>${title}</h1><p class="subtitle muted">${sub}</p></div></div>${pill}</div>`;
}

function shell(content) {
  const navItems = [
    { v: 'inicio', label: 'Inicio', icon: '⌂' },
    { v: 'biblioteca', label: 'Biblioteca completa', icon: '♫' },
    ...categories.sort((a, b) => a.orden - b.orden).map(c => ({ v: 'cat:' + c.nombre, label: c.nombre, icon: c.icono })),
    { v: 'artistas', label: 'Artistas y Bandas', icon: '👤' },
    { v: 'servicios', label: 'Servicios', icon: '▦' }
  ];

  const offlineBanner = (!isOnline || offlineMode) ? `
    <div style="background:#fff3cd;color:#856404;padding:10px 14px;border-radius:10px;margin-bottom:14px;font-size:14px">
      🔴 <b>Sin conexión.</b> Biblioteca local de consulta. Para subir o editar canciones, conéctate a internet.
    </div>
  ` : '';

  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar ${mobileMenu ? 'open' : ''}">
        <div class="brand">
          <span>♫</span>
          <span>Ministerio<br>de Alabanza<br>Yahweh</span>
        </div>
        <nav class="nav">
          ${navItems.map(n => `<button data-nav="${n.v}" class="${view === n.v || view.startsWith(n.v + ':') ? 'active' : ''}">${n.icon} &nbsp; ${escapeHtml(n.label)}</button>`).join('')}
        </nav>
        <div class="note" style="color:#ffecca;background:#233c54">
          Sesión protegida. Los archivos nuevos se guardan en Supabase y se comparten con las cuentas autorizadas.
        </div>
        <button class="btn secondary logout" data-action="logout">Cerrar sesión</button>
      </aside>
      <main class="main">${offlineBanner}${content}</main>
    </div>
  `;
}

// --- Vistas ---
function counts(catName) { return songs.filter(s => s.category === catName).length; }

function inicio() {
  const catCards = categories
    .sort((a, b) => a.orden - b.orden)
    .map(c => `<button class="card" style="background:${c.color};border:0" data-nav="cat:${c.nombre}">
      <div class="symbol">${c.icono}</div>
      <h3>${escapeHtml(c.nombre)}</h3>
      <h2 style="margin:4px 0">${counts(c.nombre)}</h2>
      <p>Ver canciones →</p>
    </button>`).join('');

  shell(header('Bienvenido', 'Organiza tus canciones y prepara los servicios.') + `
    <div class="welcome">
      <b>Tu biblioteca musical, siempre a mano.</b>
      <p class="muted">Guarda letras, acordes y repertorios desde tu celular o tablet.</p>
      <div class="row">
        <button class="btn" data-action="new-song">+ Agregar canción</button>
        <button class="btn green" data-action="bulk-import">⇧ Importar varios PDF / Word</button>
        
        <button class="btn secondary" data-action="prepare-offline">
          ⬇ Guardar biblioteca sin internet
        </button>

      </div>
    </div>
    
    <p class="muted compact" style="margin:14px 0 0">
      📦 Documentos preparados en este dispositivo:
      ${offlineProgressSummary().saved} de ${offlineProgressSummary().total}.
      Puedes reanudar la descarga cuando tengas internet.
    </p>

    <div class="cards">
      ${catCards}
      <button class="card" data-nav="biblioteca"><div class="symbol">📂</div><h3>Biblioteca completa</h3><h2>${songs.length}</h2><p>PDF, Word e imágenes →</p></button>
      <button class="card" data-nav="artistas"><div class="symbol">👤</div><h3>Artistas y Bandas</h3><h2>${artists.length}</h2><p>Administrar →</p></button>
      <button class="card" data-nav="servicios"><div class="symbol">▦</div><h3>Servicios</h3><h2>${services.length}</h2><p>Organizar repertorio →</p></button>
    </div>
    <div class="note">Biblioteca compartida: puedes acceder a las mismas canciones desde otros dispositivos con una cuenta autorizada.</div>
  `);
}

function biblioteca() {
  let catName = view.startsWith('cat:') ? view.slice(4) : null;
  let artistFilter = view.startsWith('artist:') ? view.slice(7) : '';
  const filtered = songs
    .filter(s => (!catName || s.category === catName))
    .filter(s => (!artistFilter || s.artistId === artistFilter))
    .filter(s => `${s.name} ${artistName(s.artistId)} ${s.category} ${s.tone}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  const title = catName ? catName : 'Biblioteca de canciones';

  shell(header(title, 'PDF, Word y canciones con acordes') + `
    <section class="panel">
      <div class="row between">
        <strong>${filtered.length} canciones</strong>
        <div class="row">
          <button class="btn secondary" data-action="bulk-import">⇧ Importar varios</button>
          <button class="btn green" data-action="new-song">+ Nueva canción</button>
        </div>
      </div>
      <div class="filters">
        <input id="search" class="input" placeholder="Buscar por nombre, artista o tonalidad..." value="${escapeHtml(search)}"/>
        <select id="catFilter">
          <option value="biblioteca" ${!catName ? 'selected' : ''}>Todas las categorías</option>
          ${categories.sort((a, b) => a.orden - b.orden).map(c => `<option value="cat:${c.nombre}" ${catName === c.nombre ? 'selected' : ''}>${escapeHtml(c.nombre)}</option>`).join('')}
        </select>
        <select id="artistFilter">
          <option value="biblioteca" ${!artistFilter ? 'selected' : ''}>Todos los artistas</option>
          ${artists.map(a => `<option value="artist:${a.id}" ${artistFilter === a.id ? 'selected' : ''}>${escapeHtml(a.nombre)}</option>`).join('')}
        </select>
      </div>
      ${filtered.length ? `
        <div class="scroll">
          <table class="data">
            <thead><tr><th>Canción</th><th>Artista</th><th>Categoría</th><th>Tono</th><th>Documentos</th><th>Acciones</th></tr></thead>
            <tbody>
              ${filtered.map(s => `<tr>
                <td><b>${escapeHtml(s.name)}</b>${songOfflineBadge(s)}</td>
                <td>${escapeHtml(artistName(s.artistId) || '—')}</td>
                <td>${escapeHtml(s.category)}</td>
                <td><span class="tag">${escapeHtml(s.tone || '—')}</span></td>
                <td>${fileButtons(s)}</td>
                <td>
                  <button class="btn secondary small" data-action="edit-song" data-id="${s.id}">Editar</button>
                  <button class="btn red small" data-action="delete-song" data-id="${s.id}">Borrar</button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      ` : `<div class="empty">No hay canciones todavía. Usa «Nueva canción» para agregar la primera.</div>`}
    </section>
  `);
}

function songOfflineBadge(s) {
  const files = Object.values(s.files || {}).filter(Boolean);
  if (!files.length) return s.contenidoTexto?.trim() ? '<br><small style="color:#0b9c5b">🟢 Letra disponible sin conexión</small>' : '';
  const cached = files.some(f => offlineFiles.has(f.path));
  return cached
    ? '<br><small style="color:#0b9c5b">🟢 Disponible sin conexión</small>'
    : '<br><small style="color:#73839a">⚪ Solo online</small>';
}

function fileButtons(s) {
  const btns = [];
  if (s.contenidoTexto?.trim()) btns.push(`<button class="btn secondary small" data-action="view-manual" data-id="${s.id}">🕊️ Letra</button>`);
  if (s.files?.pdf) btns.push(`<button class="btn secondary small" data-action="view-file" data-id="${s.files.pdf.id}" data-type="pdf">📄 PDF</button>`);
  if (s.files?.word) btns.push(`<button class="btn secondary small" data-action="view-file" data-id="${s.files.word.id}" data-type="word">📝 Word</button>`);
  if (s.files?.chords) btns.push(`<button class="btn secondary small" data-action="view-file" data-id="${s.files.chords.id}" data-type="pdf">🎼 Acordes</button>`);
  if (s.files?.image) btns.push(`<button class="btn secondary small" data-action="view-file" data-id="${s.files.image.id}" data-type="image">🖼 Imagen</button>`);
  if (safeUrl(s.links?.youtube)) btns.push(`<a class="btn secondary small" target="_blank" rel="noopener noreferrer" href="${safeUrl(s.links.youtube)}">▶ YouTube</a>`);
  if (safeUrl(s.links?.spotify)) btns.push(`<a class="btn secondary small" target="_blank" rel="noopener noreferrer" href="${safeUrl(s.links.spotify)}">♫ Spotify</a>`);
  if (safeUrl(s.links?.facebook)) btns.push(`<a class="btn secondary small" target="_blank" rel="noopener noreferrer" href="${safeUrl(s.links.facebook)}">f Facebook</a>`);
  return `<div class="file-list">${btns.join('')}</div>`;
}

// --- ARTISTAS Y BANDAS (con expandible) ---
function artistas() {
  const filtered = artists
    .filter(a => a.nombre.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  shell(header('Artistas y Bandas', 'Administra los artistas de tu biblioteca.') + `
    <section class="panel">
      <div class="row between">
        <strong>${filtered.length} artistas</strong>
        <button class="btn green" data-action="new-artist">+ Nuevo artista o banda</button>
      </div>
      <div class="filters">
        <input id="search" class="input" placeholder="Buscar artista por nombre..." value="${escapeHtml(search)}"/>
      </div>
      ${filtered.length ? filtered.map(a => renderArtistCard(a)).join('') : `<div class="empty">No hay artistas todavía. Usa «Nuevo artista o banda» para agregar el primero.</div>`}
    </section>
  `);
}

function renderArtistCard(a) {
  const isOpen = expandedArtists.has(a.id);
  const artistSongs = songs.filter(s => s.artistId === a.id);
  const total = artistSongs.length;

  const categoriasConCanciones = categories
    .sort((x, y) => x.orden - y.orden)
    .map(c => ({
      cat: c,
      songs: artistSongs.filter(s => s.category === c.nombre).sort((x, y) => x.name.localeCompare(y.name, 'es'))
    }));

  return `
    <section style="border:1px solid #e4eaf2;border-radius:12px;margin-bottom:10px;overflow:hidden;background:#fff">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;background:${isOpen ? '#f3f8ff' : '#fff'};cursor:pointer" data-action="toggle-artist" data-id="${a.id}">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:18px">${isOpen ? '▼' : '▶'}</span>
          <b style="font-size:16px">👤 ${escapeHtml(a.nombre)}</b>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="pill" style="background:#eef5ff;color:#1763c1">Total: ${total}</span>
          <button class="btn secondary small" data-action="edit-artist" data-id="${a.id}">✏️</button>
          <button class="btn red small" data-action="delete-artist" data-id="${a.id}">🗑</button>
        </div>
      </div>
      ${isOpen ? `
        <div style="padding:12px 16px;border-top:1px solid #e4eaf2">
          ${categoriasConCanciones.map(({ cat, songs: list }) => `
            <div style="margin-bottom:12px">
              <div style="font-weight:700;color:#24364e;padding:8px 0;border-bottom:1px solid #eef2f7">
                ${cat.icono} ${escapeHtml(cat.nombre)} <span class="muted" style="font-weight:400">(${list.length})</span>
              </div>
              ${list.length ? list.map(s => `
                <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f2f5f9">
                  <div style="flex:1;min-width:0">
                    <b>${escapeHtml(s.name)}</b>
                    <span class="muted" style="margin-left:8px">Tono ${escapeHtml(s.tone || '—')}</span>
                    ${songOfflineBadge(s)}
                  </div>
                  <div>${fileButtons(s)}</div>
                </div>
              `).join('') : `<p class="muted compact" style="padding:6px 0">Sin canciones en esta categoría.</p>`}
            </div>
          `).join('')}
        </div>
      ` : ''}
    </section>
  `;
}

// --- SERVICIOS ---
function servicios() {
  shell(header('Servicios', 'Prepara tu repertorio para cada culto o evento.') + `
    <div class="row between" style="margin-bottom:18px">
      <strong>${services.length} servicios guardados</strong>
      <div class="row">
        <button class="btn" data-action="new-service" data-id="normal">+ Servicio normal</button>
        <button class="btn green" data-action="new-service" data-id="evento">+ Matrimonio / Evento</button>
      </div>
    </div>
    <div class="cards">
      ${services.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(s => `
        <section class="card service-card">
          <h3>${escapeHtml(s.name)}</h3>
          <p class="muted compact" style="margin:4px 0">
            ${s.type === 'evento' ? '💍 Evento especial' : '⛪ Servicio normal'}
          </p>
          <p>📅 ${escapeHtml(s.date || 'Sin fecha')}<br>♫ ${(s.items || []).length} canciones</p>
          <div class="row">
            <button class="btn green" data-action="edit-service" data-id="${s.id}">Ver / Editar</button>
            <button class="btn red small" data-action="delete-service" data-id="${s.id}">Borrar</button>
          </div>
        </section>
      `).join('')}
      <button class="card" data-action="new-service" data-id="normal" style="text-align:center;border:2px dashed #bed3ee;background:#f3f8ff">
        <div class="symbol">⛪</div>
        <h3>Crear servicio normal</h3>
        <p>Culto dominical u otro</p>
      </button>
      <button class="card" data-action="new-service" data-id="evento" style="text-align:center;border:2px dashed #f0c8de;background:#fff6fa">
        <div class="symbol">💍</div>
        <h3>Crear matrimonio / evento</h3>
        <p>Boda, bals, tandas, etc.</p>
      </button>
    </div>
  `);
}

function editService() {
  const s = services.find(x => x.id === activeService);
  if (!s) { nav('servicios'); return; }

  const isEvent = s.type === 'evento';
  const baseSections = isEvent
    ? [...new Set(s.items.map(i => i.section))].filter(Boolean)
    : ['Adoración', 'Gozo', 'Ofrenda', 'Final'];
  const allSections = isEvent
    ? [...new Set([...baseSections, 'Tanda 1', 'Tanda 2'])]
    : baseSections;

  const paleta = ['#ffe5ef', '#ddf9e9', '#f0e2ff', '#ffebd9', '#e0efff', '#e8f4ff', '#fbe6e6'];

  shell(header(
    'Editar ' + (isEvent ? 'matrimonio / evento' : 'servicio'),
    isEvent ? 'Organiza las canciones por tandas o momentos.' : 'Organiza las canciones en el orden que se interpretarán.'
  ) + `
    <section class="panel">
      <div class="row between">
        <strong>Datos del ${isEvent ? 'evento' : 'servicio'}</strong>
        <div class="row">
          <button class="btn secondary" data-nav="servicios">Volver</button>
          <button class="btn green" data-action="save-service">Guardar</button>
        </div>
      </div>
      <div class="gridform" style="margin-top:18px">
        <div class="field">
          <label>Nombre</label>
          <input class="input" id="service-name" value="${escapeHtml(s.name)}"/>
        </div>
        <div class="field">
          <label>Fecha</label>
          <input class="input" id="service-date" type="date" value="${escapeHtml(s.date)}"/>
        </div>
        <div class="field full">
          <label>Descripción (opcional)</label>
          <input class="input" id="service-desc" value="${escapeHtml(s.description || '')}"/>
        </div>
      </div>

      ${isEvent ? `
        <div class="row between" style="margin-top:24px">
          <h3 style="margin:0">Secciones del evento (${allSections.length})</h3>
          <button class="btn" data-action="add-section">+ Agregar sección</button>
        </div>
      ` : `<h3 style="margin-top:24px">Lista de canciones (${s.items.length})</h3>`}

      ${allSections.map((sec, idx) => {
        const items = s.items.filter(x => x.section === sec);
        const bg = paleta[idx % paleta.length];
        return `
          <section class="section">
            <div class="section-header" style="background:${bg}">
              <span>
                ${isEvent ? '💍' : '⛪'} &nbsp; ${escapeHtml(sec)} <small>(${items.length})</small>
                ${isEvent ? `
                  <button class="link small" data-action="rename-section" data-id="${escapeHtml(sec)}" style="margin-left:8px" title="Renombrar">✏️</button>
                  <button class="link small" data-action="delete-section" data-id="${escapeHtml(sec)}" style="color:#b42332" title="Eliminar">🗑</button>
                ` : ''}
              </span>
              <button class="btn secondary small" data-action="add-to-service" data-section="${escapeHtml(sec)}">+ Agregar</button>
            </div>
            <div class="section-body">
              ${items.length ? items.map(item => {
                const song = songs.find(x => x.id === item.songId);
                return `
                  <div class="song-row">
                    <div class="song-title">
                      <b>${escapeHtml(song?.name || 'Canción eliminada')}</b>
                      ${song ? songOfflineBadge(song) : ''}
                      <div class="file-list">${song ? fileButtons(song) : ''}</div>
                    </div>
                    <select style="width:90px" data-tone="${item.id}">${toneOptions(item.tone)}</select>
                    <div class="section-actions">
                      <button class="btn secondary small" data-action="up-item" data-id="${item.id}" title="Subir">↑</button>
                      <button class="btn secondary small" data-action="down-item" data-id="${item.id}" title="Bajar">↓</button>
                      <button class="btn red small" data-action="remove-item" data-id="${item.id}" title="Quitar">×</button>
                    </div>
                  </div>
                `;
              }).join('') : `<p class="muted compact">Sin canciones en esta sección.</p>`}
            </div>
          </section>
        `;
      }).join('')}
    </section>
  `);
}

// --- Modales ---
function modal(title, html, opts = {}) {
  let overlay = document.createElement('div');
  overlay.className = 'modal-bg';
  overlay.id = 'overlay';
  if (opts.wide) overlay.style.padding = '8px';
  overlay.innerHTML = `<div class="modal" style="${opts.wide ? 'width:min(1000px,100%);max-height:96dvh' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
    <div class="row between" style="margin-bottom:20px">
      <h2 style="margin:0">${escapeHtml(title)}</h2>
      <button class="btn secondary" data-action="close-modal">✕</button>
    </div>
    ${html}
  </div>`;
  document.body.append(overlay);
}

function newSongModal(song) {
  const s = song || { name: '', category: categories[0]?.nombre || 'Adoración', tone: '', artistId: '', links: {}, files: {} };
  const catOpts = categories.sort((a, b) => a.orden - b.orden)
    .map(c => `<option value="${c.nombre}" ${s.category === c.nombre ? 'selected' : ''}>${escapeHtml(c.nombre)}</option>`).join('');

  const form = `
    <form id="song-form" data-id="${song?.id || ''}">
      <div class="gridform">
        <div class="field full">
          <label>Nombre de la canción *</label>
          <input class="input" name="name" required value="${escapeHtml(s.name)}" placeholder="Ej. A Él sea la gloria"/>
        </div>
        <div class="field">
          <label>Artista o banda</label>
          <select name="artistId">${artistOptions(s.artistId)}</select>
        </div>
        <div class="field">
          <label>Categoría</label>
          <select name="category">${catOpts}</select>
        </div>
        <div class="field">
          <label>Tonalidad</label>
          <select name="tone">${toneOptions(s.tone)}</select>
        </div>
        <div class="field full manual-editor">
          <label for="song-manual-text">✍️ Escribir letra manualmente (opcional)</label>
          <p class="hint">Puedes escribir una letra sin subir Word o PDF. La plantilla de dos palomitas aparece automáticamente al visualizarla. Escribe CORO, INTRODUCCIÓN, INSTRUMENTAL, VERSO o PUENTE en líneas independientes para colorearlas.</p>
          <textarea id="song-manual-text" name="manualLyrics" rows="10" placeholder="INTRODUCCIÓN&#10;&#10;Escribe la letra aquí...&#10;&#10;CORO&#10;&#10;Escribe el coro aquí...">${escapeHtml(s.contenidoTexto || '')}</textarea>
          <details class="manual-preview-wrap"><summary>👁 Vista previa con las dos palomitas</summary>
            <div id="song-manual-preview" class="manual-lyric-page"></div>
          </details>
        </div>
        ${[['pdf', 'Letra PDF'], ['word', 'Letra Word'], ['chords', 'Canción con acordes (PDF) — opcional'], ['image', 'Imagen con acordes — opcional']]
          .map(([k, label]) => `<div class="field upload">
            <label>${label}</label>
            <input type="file" name="${k}" accept="${k === 'pdf' || k === 'chords' ? '.pdf,application/pdf' : k === 'word' ? '.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'image/*'}"/>
            ${s.files?.[k] ? `<p class="hint">Actual: ${escapeHtml(s.files[k].name)} — deja vacío para conservarlo.</p>` : ''}
          </div>`).join('')}
        ${[['youtube', 'YouTube'], ['spotify', 'Spotify'], ['facebook', 'Facebook']]
          .map(([k, label]) => `<div class="field">
            <label>Enlace ${label} (opcional)</label>
            <input class="input" name="${k}" type="url" placeholder="https://..." value="${escapeHtml(s.links?.[k] || '')}"/>
          </div>`).join('')}
      </div>
      <div class="row between">
        <button class="btn secondary" type="button" data-action="close-modal">Cancelar</button>
        <button class="btn green" type="submit">Guardar canción</button>
      </div>
    </form>
  `;

  modal(song ? 'Editar canción' : 'Agregar nueva canción', form);
  updateLyricsPreview();
}

function newArtistModal(artist) {
  const a = artist || { name: '' };
  modal(artist ? 'Editar artista o banda' : 'Nuevo artista o banda', `
    <form id="artist-form" data-id="${artist?.id || ''}">
      <div class="field">
        <label>Nombre del artista o banda *</label>
        <input class="input" name="name" required value="${escapeHtml(a.name)}" placeholder="Ej. Miel San Marcos"/>
      </div>
      <div class="row between">
        <button class="btn secondary" type="button" data-action="close-modal">Cancelar</button>
        <button class="btn green" type="submit">Guardar artista</button>
      </div>
    </form>
  `);
}

function bulkImportModal() {
  let ix = view.startsWith('cat:') ? view.slice(4) : (categories[0]?.nombre || 'Adoración');
  const catOpts = categories.sort((a, b) => a.orden - b.orden)
    .map(c => `<option ${c.nombre === ix ? 'selected' : ''}>${escapeHtml(c.nombre)}</option>`).join('');

  modal('Importar varios PDF y Word', `
    <form id="bulk-form">
      <div class="field">
        <label>Categoría para estas canciones</label>
        <select name="category">${catOpts}</select>
      </div>
      <div class="field">
        <label>Artista o banda (opcional)</label>
        <select name="artistId">${artistOptions('')}</select>
      </div>
      <div class="field upload" style="margin:16px 0">
        <label>Selecciona varios archivos PDF o Word</label>
        <input name="documents" type="file" multiple required accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"/>
        <p class="hint" id="bulk-preview">Puedes seleccionar 5, 10, 20 o más archivos a la vez.</p>
      </div>
      <p class="hint">Si el nombre y formato ya existen en la categoría, se omitirán para evitar duplicados.</p>
      <div class="row between">
        <button class="btn secondary" type="button" data-action="close-modal">Cancelar</button>
        <button class="btn green" type="submit" id="bulk-submit">Importar canciones</button>
      </div>
    </form>
  `);
}

async function importBulk(form) {
  const fd = new FormData(form);
  const category = String(fd.get('category'));
  const artistId = String(fd.get('artistId') || '') || null;
  const files = Array.from(form.querySelector('[name="documents"]').files || []);
  let added = 0, linked = 0, skipped = 0, failed = 0;
  const button = document.getElementById('bulk-submit');
  button.disabled = true;
  button.textContent = 'Importando...';
  const known = [...songs];

  for (const f of files) {
    const ext = f.name.split('.').pop().toLowerCase();
    const key = ext === 'pdf' ? 'pdf' : (['doc', 'docx'].includes(ext) ? 'word' : null);
    if (!key || !f.size || f.size > 25 * 1024 * 1024) { skipped++; continue; }
    const name = f.name.replace(/\.(pdf|docx?)$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) { skipped++; continue; }
    const existing = known.find(x => x.category === category && normalize(x.name) === normalize(name));
    if (existing?.files?.[key]) { skipped++; continue; }

    let fileId = null;
    const created = !existing;
    const song = existing
      ? { ...existing, files: { ...existing.files }, artistId: existing.artistId || artistId }
      : { id: uuid(), name, category, tone: '', artistId, links: {}, files: {}, contenidoTexto: '' };

    try {
      const uploaded = await uploadSongFile(f);
      fileId = uploaded.path;
      song.files[key] = uploaded;

      // Extraer texto para offline
      const texto = await extractText(f);
      if (texto) song.contenidoTexto = texto;

      await put('songs', song);
      if (created) { known.push(song); added++; } else linked++;
    } catch (err) {
      console.error('Error importando', f.name, err);
      failed++;
      try { if (fileId) await del('files', fileId); } catch (_) {}
    }
  }

  document.getElementById('overlay')?.remove();
  await refresh();
  alert(`Importación terminada.\nCanciones nuevas: ${added}\nArchivos añadidos a canciones existentes: ${linked}\nOmitidos: ${skipped}\nErrores: ${failed}`);
}

function addSongModal(section = 'Adoración') {
  const list = songs.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const service = services.find(s => s.id === activeService);
  modal(service?.type === 'evento' ? 'Agregar canción al matrimonio' : 'Agregar canción al servicio', `
    <div class="field">
      <label>Sección</label>
      <input class="input" id="section-choose" value="${escapeHtml(section)}"/>
    </div>
    <div class="field">
      <label>Buscar canción</label>
      <input class="input" id="find-song" placeholder="Buscar canción..."/>
    </div>
    <div class="field">
      <label for="add-song-category">Filtrar por categoría</label>
      <select id="add-song-category"><option value="">Todas las categorías</option>
        ${categories.slice().sort((a,b) => a.orden - b.orden).map(c => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nombre)}</option>`).join('')}
      </select>
    </div>
    <div id="add-song-results">${renderAddResults(list)}</div>
    <div class="note">Si no está en la biblioteca, cierra esta ventana y utiliza «Nueva canción» para subirla.</div>
  `);
}

function renderAddResults(items) {
  return items.length ? items.map(s => `
    <div class="song-row">
      <div class="song-title">
        <b>${escapeHtml(s.name)}</b>
        <p class="muted compact" style="margin:4px 0">${escapeHtml(artistName(s.artistId) || s.category)} · Tono ${escapeHtml(s.tone || 'sin definir')}</p>
      </div>
      <button class="btn small" data-action="attach-song" data-id="${s.id}">Agregar</button>
    </div>
  `).join('') : '<div class="empty">No se encontraron canciones.</div>';
}

// --- VISOR EMBEBIDO ---
async function viewFile(path, type) {
  const song = songs.find(s => Object.values(s.files || {}).some(f => f?.path === path));
  const fileName = song ? Object.values(song.files).find(f => f?.path === path)?.name : path;
  const title = song ? `${song.name} — ${fileName || ''}` : fileName;

  // Si es imagen → mostrar embebida
  if (type === 'image') {
    await showImageViewer(title, path);
    return;
  }

  // Para PDF: intentar embed
  if (type === 'pdf') {
    await showPdfViewer(title, path);
    return;
  }

  
    // Mostrar Word DOCX dentro de la aplicación    
    if (type === 'word') {
      try {
        const blob = await getFileBlob(path);
        const arrayBuffer = await blob.arrayBuffer();

        const resultado = await mammoth.convertToHtml({
          arrayBuffer
        });

        const htmlOriginal = resultado.value;

        if (!htmlOriginal.trim()) {
          toast('El documento no contiene texto visible.');
          return;
        }

        function prepararHtmlWord(html, nombreArchivo) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(`<div id="wrap">${html}</div>`, 'text/html');
          const wrap = doc.getElementById('wrap');

          // Eliminar párrafos totalmente vacíos
          wrap.querySelectorAll('p').forEach(p => {
            if (!p.textContent.trim() && !p.querySelector('img')) {
              p.remove();
            }
          });

          const children = [...wrap.children];

          // Buscar imágenes al inicio
          const primerBloque = children[0];
          let headerImages = [];
          let possibleTitle = '';

          if (primerBloque) {
            headerImages = [...primerBloque.querySelectorAll('img')];

            // Si ese mismo bloque tiene texto, lo tomamos como posible título
            const text = primerBloque.textContent.trim();
            if (text) possibleTitle = text;
          }

          // Buscar un título más limpio en los primeros elementos
          let detectedTitle = '';
          for (const el of children.slice(0, 4)) {
            const txt = el.textContent.trim();
            if (!txt) continue;

            // Preferimos un texto corto como título
            if (txt.length <= 40) {
              detectedTitle = txt;
              break;
            }
          }

          const tituloFinal = detectedTitle || possibleTitle || nombreArchivo.replace(/\.[^/.]+$/, '');

          // Crear nuevo contenedor ordenado
          const nuevo = doc.createElement('div');
          nuevo.className = 'word-clean';

          // Encabezado con imágenes
          if (headerImages.length) {
            const header = doc.createElement('div');
            header.className = 'word-header-images';

            headerImages.slice(0, 2).forEach(img => {
              const clon = img.cloneNode(true);
              header.appendChild(clon);
            });

            nuevo.appendChild(header);
          }

          // Título
          const h1 = doc.createElement('h1');
          h1.textContent = tituloFinal.toUpperCase();
          h1.className = 'word-main-title';
          nuevo.appendChild(h1);

          // Recorrer contenido y reconstruirlo
          children.forEach((el, index) => {
            // Saltar el primer bloque si era solo imágenes/título mezclado
            if (index === 0) return;

            const texto = el.textContent.trim();
            const tieneImagen = el.querySelector('img');

            if (tieneImagen) {
              // Ignorar imágenes sueltas posteriores por ahora
              return;
            }

            if (!texto) return;

            // Saltar si el texto es el mismo título
            if (texto.toUpperCase() === tituloFinal.toUpperCase()) return;

            const p = doc.createElement('p');
            p.innerHTML = el.innerHTML;
            nuevo.appendChild(p);
          });

          markWordHeadings(nuevo);
          return nuevo.innerHTML;
        }

        const html = prepararHtmlWord(htmlOriginal, title);

        let modo = 'original';
        let tamano = 18;
        let oscuro = false;

        modal(title, `
          <div class="row between" style="margin-bottom:15px;gap:8px">
            <div class="row">
              <button class="btn secondary small" id="vista-original">
                Vista original
              </button>
              <button class="btn secondary small" id="vista-lectura">
                Vista lectura
              </button>
            </div>

            <div class="row">
              <button class="btn secondary small" id="letra-menos">A−</button>
              <button class="btn secondary small" id="letra-mas">A+</button>
              <button class="btn secondary small" id="modo-oscuro">🌙</button>
              <button class="btn secondary small" id="pantalla-completa">⛶</button>
            </div>
          </div>

          <iframe
            id="word-viewer"
            sandbox=""
            title="Visor de canciones"
            style="width:100%;height:68dvh;border:1px solid #dfe6ef;border-radius:12px;background:white">
          </iframe>

          <div class="row between" style="margin-top:15px">
            <button class="btn secondary"
              data-action="download-file"
              data-id="${escapeHtml(path)}">
              ⬇ Descargar original
            </button>

            <button class="btn secondary" data-action="close-modal">
              Cerrar
            </button>
          </div>
        `, { wide: true });

        const overlay = document.getElementById('overlay');
        const iframe = overlay.querySelector('#word-viewer');

        function actualizarVisor() {
          const lectura = modo === 'lectura';

          const css = `
          * { box-sizing: border-box; }

          html {
            background: ${oscuro ? '#0f1728' : '#f5f6f8'};
          }

          body {
            max-width: 900px;
            margin: 0 auto;
            padding: 28px 20px 60px;
            background: ${oscuro ? '#0f1728' : '#f5f6f8'};
            color: ${oscuro ? '#f8fafc' : '#111827'};
            font-family: Arial, sans-serif;
            font-size: ${tamano}px;
            line-height: ${lectura ? '1.9' : '1.65'};
            overflow-wrap: break-word;
          }

          .word-clean {
            background: ${oscuro ? '#111c31' : '#ffffff'};
            border-radius: 16px;
            padding: 36px 26px 42px;
            box-shadow: ${oscuro ? '0 0 0 rgba(0,0,0,0)' : '0 10px 30px rgba(0,0,0,0.07)'};
            min-height: 100%;
          }

          .word-header-images {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 30px;
            margin-bottom: 18px;
          }

          .word-header-images img {
            width: min(170px, 28%);
            max-width: 170px;
            height: auto;
            object-fit: contain;
          }

          .word-main-title {
            text-align: center;
            color: ${oscuro ? '#9ec5ff' : '#5a78b5'};
            font-size: ${lectura ? '2.0em' : '1.8em'};
            margin: 8px 0 28px;
            font-weight: 700;
            letter-spacing: 0.5px;
          }

          p {
            margin: 0 0 ${lectura ? '16px' : '10px'};
            text-align: center;
            font-size: ${lectura ? '1.08em' : '1em'};
          }

          h1, h2, h3 {
            text-align: center;
            color: ${oscuro ? '#9ec5ff' : '#4165a0'};
            margin: 0 0 20px;
          }

          img {
            max-width: 100%;
            height: auto;
          }

          table {
            max-width: 100%;
            margin: auto;
          }

          td, th {
            padding: 4px;
            vertical-align: top;
          }

          a {
            color: ${oscuro ? '#a9c7ff' : '#1765cb'};
          }

          .word-clean p:empty { display:none; }
          .lyric-part {font-weight:800 !important; letter-spacing:.45px; margin-top:20px !important;}
          .lyric-intro, .lyric-instrumental, .lyric-verso, .lyric-puente, .lyric-final {color:${oscuro ? '#93c5fd' : '#173b77'} !important;}
          .lyric-coro {color:${oscuro ? '#fda4af' : '#b91c1c'} !important;}
        `;
          // El iframe aislado no ejecuta scripts del documento.
          iframe.srcdoc = `
            <!DOCTYPE html>
            <html lang="es">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style>${css}</style>
            </head>
            <body>${html}</body>
            </html>
          `;

          overlay.querySelector('#vista-original').style.background =
            modo === 'original' ? '#1372ee' : '#eaf2ff';

          overlay.querySelector('#vista-original').style.color =
            modo === 'original' ? '#fff' : '#1763c1';

          overlay.querySelector('#vista-lectura').style.background =
            modo === 'lectura' ? '#1372ee' : '#eaf2ff';

          overlay.querySelector('#vista-lectura').style.color =
            modo === 'lectura' ? '#fff' : '#1763c1';
        }

        overlay.querySelector('#vista-original').addEventListener('click', () => {
          modo = 'original';
          actualizarVisor();
        });

        overlay.querySelector('#vista-lectura').addEventListener('click', () => {
          modo = 'lectura';
          actualizarVisor();
        });

        overlay.querySelector('#letra-mas').addEventListener('click', () => {
          tamano = Math.min(tamano + 2, 36);
          actualizarVisor();
        });

        overlay.querySelector('#letra-menos').addEventListener('click', () => {
          tamano = Math.max(tamano - 2, 12);
          actualizarVisor();
        });

        overlay.querySelector('#modo-oscuro').addEventListener('click', () => {
          oscuro = !oscuro;
          actualizarVisor();
        });

        overlay.querySelector('#pantalla-completa').addEventListener('click', async () => {
          const ventana = overlay.querySelector('.modal');

          if (!document.fullscreenElement) {
            await ventana.requestFullscreen();
            ventana.style.width = '100%';
            ventana.style.maxHeight = '100dvh';
            iframe.style.height = 'calc(100dvh - 200px)';
          } else {
            await document.exitFullscreen();
            iframe.style.height = '68dvh';
          }
        });

        actualizarVisor();

      } catch (error) {
        console.error(error);
        toast('Error al visualizar Word: ' + error.message);
      }

      return;
    }


  ;
}

function showTextViewer(title, text, path, type) {
  modal(title, `
    <div style="max-height:70dvh;overflow:auto;padding:18px;background:#fbfcfe;border-radius:10px;border:1px solid #e4eaf2">
      <pre style="white-space:pre-wrap;font-family:inherit;font-size:15px;line-height:1.7;margin:0">${escapeHtml(text)}</pre>
    </div>
    <div class="row between" style="margin-top:16px">
      <div class="row">
        <button class="btn secondary" data-action="download-file" data-id="${escapeHtml(path)}">⬇ Descargar original</button>
        ${songs.find(s => Object.values(s.files || {}).some(f => f?.path === path))?.links?.youtube ? `<a class="btn secondary" target="_blank" rel="noopener noreferrer" href="${safeUrl(songs.find(s => Object.values(s.files || {}).some(f => f?.path === path)).links.youtube)}">▶ YouTube</a>` : ''}
      </div>
      <button class="btn secondary" data-action="close-modal">Cerrar</button>
    </div>
  `, { wide: true });
}

async function showImageViewer(title, path) {
  modal(title, `
    <div style="text-align:center;background:#fbfcfe;border-radius:10px;padding:10px">
      <div id="img-loading">Cargando imagen...</div>
      <img id="img-viewer" style="max-width:100%;max-height:70dvh;display:none;border-radius:8px" alt=""/>
    </div>
    <div class="row between" style="margin-top:16px">
      <button class="btn secondary" data-action="download-file" data-id="${escapeHtml(path)}">⬇ Descargar</button>
      <button class="btn secondary" data-action="close-modal">Cerrar</button>
    </div>
  `, { wide: true });

  try {
    const blob = await getFileBlob(path);
    const url = URL.createObjectURL(blob);
    const img = document.getElementById('img-viewer');
    const loading = document.getElementById('img-loading');
    if (img) { img.src = url; img.style.display = 'inline-block'; }
    if (loading) loading.style.display = 'none';
    detectOfflineFiles().then(() => {}); // refrescar cache
  } catch (e) {
    const loading = document.getElementById('img-loading');
    if (loading) loading.textContent = 'No se pudo cargar la imagen: ' + e.message;
  }
}

async function showPdfViewer(title, path) {
  modal(title, `
    <div style="background:#fbfcfe;border-radius:10px;padding:6px">
      <div id="pdf-loading" style="padding:20px;text-align:center;color:#64748b">Cargando PDF...</div>
      <iframe id="pdf-viewer" style="width:100%;height:70dvh;border:0;display:none;border-radius:8px" title="Visor PDF"></iframe>
    </div>
    <div class="row between" style="margin-top:16px">
      <button class="btn secondary" data-action="download-file" data-id="${escapeHtml(path)}">⬇ Descargar</button>
      <button class="btn secondary" data-action="close-modal">Cerrar</button>
    </div>
  `, { wide: true });

  try {
    const blob = await getFileBlob(path);
    const url = URL.createObjectURL(blob);
    const iframe = document.getElementById('pdf-viewer');
    const loading = document.getElementById('pdf-loading');
    if (iframe) { iframe.src = url; iframe.style.display = 'block'; }
    if (loading) loading.style.display = 'none';
    detectOfflineFiles().then(() => {});
  } catch (e) {
    const loading = document.getElementById('pdf-loading');
    if (loading) loading.textContent = 'No se pudo cargar el PDF: ' + e.message;
  }
}

async function openExternal(path) {
  try {
    const signed = checked(await supa.storage.from('canciones').createSignedUrl(path, 300));
    window.open(signed.signedUrl, '_blank', 'noopener,noreferrer');
  } catch (e) {
    toast('No se pudo abrir: ' + e.message);
  }
}

async function downloadFile(path) {
  try {
    const blob = await getFileBlob(path);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = decodeURIComponent(path.split('/').slice(1).join('/')) || 'archivo';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    toast('No se pudo descargar: ' + e.message);
  }
}

// --- Login ---
function loginScreen(message = '') {
  app.innerHTML = `
    <main class="auth-wrap">
      <section class="auth-panel">
        <div class="auth-brand">♫</div>
        <h1>Ministerio de Alabanza Yahweh</h1>
        <p class="muted">Inicia sesión con tu cuenta autorizada de Supabase.</p>
        <form id="login-form">
          <div class="field">
            <label for="login-email">Correo electrónico</label>
            <input class="input" id="login-email" type="email" autocomplete="username" required placeholder="tucorreo@ejemplo.com">
          </div>
          <div class="field">
            <label for="login-password">Contraseña</label>
            <input class="input" id="login-password" type="password" autocomplete="current-password" required placeholder="Tu contraseña">
          </div>
          <p id="login-error" class="auth-error" role="alert">${escapeHtml(message)}</p>
          <button class="btn auth-submit" type="submit">Iniciar sesión</button>
        </form>
        <p class="hint">No hay registro público. Las cuentas se crean desde Supabase.</p>
        <p class="auth-note">Etapa de nube: las canciones nuevas se guardarán en Supabase.</p>
      </section>
    </main>
  `;
}

// --- Render ---
function render() {
  if (cloudProblem && currentUser) {
    app.innerHTML = `<div class="panel" style="margin:32px">
      <h2>No se pudo cargar la nube</h2>
      <p>${escapeHtml(cloudProblem)}</p>
      <button class="btn" data-action="retry">Reintentar</button>
    </div>`;
    return;
  }
  if (!authReady) { app.innerHTML = '<div class="auth-loading">Verificando sesión...</div>'; return; }
  if (!currentUser) { loginScreen(); return; }

  if (view === 'inicio') inicio();
  else if (view === 'artistas') artistas();
  else if (view === 'servicios') servicios();
  else if (view === 'editar-servicio') editService();
  else biblioteca();
}

function saveFields(s) {
  s.name = document.getElementById('service-name').value.trim() || 'Servicio sin nombre';
  s.date = document.getElementById('service-date').value;
  s.description = document.getElementById('service-desc').value.trim();
  return put('services', s);
}

// --- Acciones ---
async function act(action, id, section) {
  
  if (action === 'prepare-offline') {
    await prepareOfflineLibrary();
    return;
  }

  if (action === 'retry') { await refresh(); return; }
  if (action === 'logout') { if (!navigator.onLine) { toast('Para cerrar sesión de forma segura, reconéctate a internet.'); return; } const uid = currentUser?.id; if (supa) await supa.auth.signOut(); currentUser = null; if (uid) await clearOfflineUser(uid); songs = []; services = []; artists = []; render(); return; }
  if (!['retry','logout','menu','close-modal','toggle-artist','view-file','view-manual','download-file'].includes(action) && !requireInternet()) return;
  if (action === 'menu') { mobileMenu = !mobileMenu; render(); return; }
  if (action === 'new-song') { newSongModal(); return; }
  if (action === 'bulk-import') { bulkImportModal(); return; }
  if (action === 'edit-song') { newSongModal(songs.find(s => s.id === id)); return; }
  if (action === 'close-modal') { document.getElementById('overlay')?.remove(); return; }
  if (action === 'new-artist') { newArtistModal(); return; }
  if (action === 'edit-artist') { newArtistModal(artists.find(a => a.id === id)); return; }
  if (action === 'toggle-artist') {
    if (expandedArtists.has(id)) expandedArtists.delete(id); else expandedArtists.add(id);
    render();
    return;
  }
  if (action === 'view-manual') { manualLyricsViewer(id); return; }
  if (action === 'view-file') { await viewFile(id, section || 'pdf'); return; }
  if (action === 'download-file') { await downloadFile(id); return; }

  if (action === 'delete-artist') {
    if (!confirm('¿Eliminar este artista? Las canciones NO se eliminarán, solo quedarán sin artista.')) return;
    await del('artists', id);
    await refresh();
    toast('Artista eliminado');
    return;
  }
  if (action === 'delete-song') {
    if (!confirm('¿Eliminar esta canción? Se quitará de los servicios.')) return;
    const song = songs.find(s => s.id === id);
    await del('songs', id);
    for (const f of Object.values(song.files || {})) if (f?.path) await del('files', f.path);
    await refresh();
    toast('Canción eliminada');
    return;
  }

  // Servicios
  if (action === 'new-service') {
    const type = id === 'evento' ? 'evento' : 'normal';
    const name = type === 'evento' ? 'Matrimonio / Evento' : 'Nuevo servicio';
    const s = { id: uuid(), name, date: new Date().toLocaleDateString('en-CA'), description: '', type, items: [] };
    await put('services', s);
    activeService = s.id;
    view = 'editar-servicio';
    await refresh();
    return;
  }
  if (action === 'edit-service') { activeService = id; view = 'editar-servicio'; render(); return; }
  if (action === 'delete-service') {
    if (!confirm('¿Eliminar este servicio?')) return;
    await del('services', id);
    await refresh();
    toast('Servicio eliminado');
    return;
  }
  if (action === 'save-service') {
    const s = services.find(x => x.id === activeService);
    await saveFields(s);
    await refresh();
    toast('Servicio guardado');
    return;
  }
  if (action === 'add-to-service') {
    const s = services.find(x => x.id === activeService);
    await saveFields(s);
    await refresh();
    addSongModal(section);
    return;
  }
  if (action === 'attach-song') {
    const s = services.find(x => x.id === activeService);
    const song = songs.find(x => x.id === id);
    const sec = document.getElementById('section-choose').value || 'Adoración';
    s.items.push({ id: uuid(), songId: id, section: sec, tone: song.tone });
    await put('services', s);
    document.getElementById('overlay')?.remove();
    await refresh();
    toast('Canción agregada');
    return;
  }
  if (action === 'add-section') {
    const name = prompt('Nombre de la nueva sección (ej. Tanda 3, Bals, Tanda Cumbia):');
    if (!name || !name.trim()) return;
    const s = services.find(x => x.id === activeService);
    s.items.push({ id: uuid(), songId: null, section: name.trim(), tone: '' });
    await put('services', s);
    await refresh();
    toast('Sección agregada');
    return;
  }
  if (action === 'rename-section') {
    const oldName = id;
    const s = services.find(x => x.id === activeService);
    const newName = prompt('Nuevo nombre de la sección:', oldName);
    if (!newName || newName === oldName || !newName.trim()) return;
    s.items.forEach(i => { if (i.section === oldName) i.section = newName.trim(); });
    await put('services', s);
    await refresh();
    toast('Sección renombrada');
    return;
  }
  if (action === 'delete-section') {
    const secName = id;
    const s = services.find(x => x.id === activeService);
    if (!confirm(`¿Eliminar la sección "${secName}" y todas sus canciones del servicio?`)) return;
    s.items = s.items.filter(i => i.section !== secName);
    await put('services', s);
    await refresh();
    toast('Sección eliminada');
    return;
  }
  if (['up-item', 'down-item', 'remove-item'].includes(action)) {
    const s = services.find(x => x.id === activeService);
    const index = s.items.findIndex(x => x.id === id);
    const item = s.items[index];
    if (!item) return;
    if (action === 'remove-item') s.items.splice(index, 1);
    else {
      const indices = s.items.map((x, i) => x.section === item.section ? i : -1).filter(i => i >= 0);
      const p = indices.indexOf(index);
      const target = indices[p + (action === 'up-item' ? -1 : 1)];
      if (target !== undefined) [s.items[index], s.items[target]] = [s.items[target], s.items[index]];
    }
    await put('services', s);
    await refresh();
  }
}

// --- Listeners ---
document.addEventListener('click', async e => {
  const n = e.target.closest('[data-nav]');
  if (n) { nav(n.dataset.nav); return; }
  const a = e.target.closest('[data-action]');
  if (a) await act(a.dataset.action, a.dataset.id, a.dataset.section || a.dataset.type);
});

function filterAddSongResults() {
  const query = normalize(document.getElementById('find-song')?.value || '');
  const category = document.getElementById('add-song-category')?.value || '';
  const el = document.getElementById('add-song-results');
  if (!el) return;
  el.innerHTML = renderAddResults(songs.filter(s =>
    (!category || s.category === category) &&
    (!query || normalize(s.name + ' ' + artistName(s.artistId)).includes(query))
  ).sort((a,b) => a.name.localeCompare(b.name, 'es')));
}
document.addEventListener('input', e => {
  if (e.target.id === 'song-manual-text' || (e.target.name === 'name' && e.target.closest('#song-form'))) updateLyricsPreview();
  if (e.target.id === 'search') {
    const val = e.target.value;
    search = val;
    const pos = e.target.selectionStart;
    render();
    const field = document.getElementById('search');
    if (field) { field.focus(); field.setSelectionRange(pos, pos); }
  }
  if (e.target.id === 'find-song') filterAddSongResults();
});

document.addEventListener('change', async e => {
  if (e.target.id === 'add-song-category') { filterAddSongResults(); return; }
  if (e.target.name === 'documents' && e.target.closest('#bulk-form')) {
    const n = e.target.files.length;
    const el = document.getElementById('bulk-preview');
    if (el) el.textContent = n ? `${n} archivo(s) seleccionados` : 'Selecciona varios archivos PDF o Word';
  }
  if (e.target.id === 'catFilter') nav(e.target.value);
  if (e.target.id === 'artistFilter') nav(e.target.value);
  if (e.target.dataset.tone) {
    if (!requireInternet()) { render(); return; }
    const s = services.find(x => x.id === activeService);
    const item = s.items.find(i => i.id === e.target.dataset.tone);
    if (item) {
      item.tone = e.target.value;
      await put('services', s);
      toast('Tonalidad actualizada');
    }
  }
});

document.addEventListener('submit', async e => {
  if (e.target.id === 'login-form') {
    e.preventDefault();
    if (!requireInternet()) return;
    if (!supa) { loginScreen('No se pudo cargar Supabase. Comprueba tu conexión a internet.'); return; }
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Ingresando...';
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const { data, error } = await supa.auth.signInWithPassword({ email, password });
    if (error) {
      const el = document.getElementById('login-error');
      if (el) el.textContent = 'No se pudo iniciar sesión. Revisa correo, contraseña y confirmación de la cuenta.';
      btn.disabled = false;
      btn.textContent = 'Iniciar sesión';
      return;
    }
    currentUser = data.user;
    await refresh();
    return;
  }

  if (e.target.id === 'bulk-form') { e.preventDefault(); if (!requireInternet()) return; await importBulk(e.target); return; }

  if (e.target.id === 'artist-form') {
    e.preventDefault();
    if (!requireInternet()) return;
    const form = e.target;
    const fd = new FormData(form);
    const id = form.dataset.id || uuid();
    const name = String(fd.get('name')).trim();
    if (!name) { toast('Escribe un nombre'); return; }
    try {
      await put('artists', { id, name });
      document.getElementById('overlay')?.remove();
      await refresh();
      toast('Artista guardado');
    } catch (err) { toast('Error: ' + err.message); }
    return;
  }

  if (e.target.id !== 'song-form') return;
  e.preventDefault();
  if (!requireInternet()) return;
  const form = e.target;
  const fd = new FormData(form);
  const id = form.dataset.id || uuid();
  const current = songs.find(s => s.id === id);
  const s = {
    id,
    name: String(fd.get('name')).trim(),
    category: fd.get('category'),
    artistId: String(fd.get('artistId') || '') || null,
    tone: fd.get('tone'),
    contenidoTexto: String(fd.get('manualLyrics') ?? current?.contenidoTexto ?? ''),
    links: {
      youtube: fd.get('youtube'),
      spotify: fd.get('spotify'),
      facebook: fd.get('facebook')
    },
    files: { ...(current?.files || {}) }
  };
  if (!s.name) { toast('Escribe un nombre'); return; }
  const pendingCleanup = [];
  try {
    for (const key of ['pdf', 'word', 'chords', 'image']) {
      const f = fd.get(key);
      if (f instanceof File && f.size) {
        if (f.size > 25 * 1024 * 1024) { toast('Cada archivo debe pesar menos de 25 MB'); return; }
        const old = s.files[key];
        const uploaded = await uploadSongFile(f);
        s.files[key] = uploaded;
        if (old?.path) pendingCleanup.push(old.path);

        // Extraer texto si es PDF o Word
        if (key === 'pdf' || key === 'word') {
          const texto = await extractText(f);
          if (texto) s.contenidoTexto = texto;
        }
      }
    }
    await put('songs', s);
    for (const path of pendingCleanup) {
      try { await del('files', path); } catch (e) { console.warn(e); }
    }
    document.getElementById('overlay').remove();
    await refresh();
    toast('Canción guardada en la nube');
  } catch (err) {
    console.error(err);
    toast('Error al guardar en Supabase: ' + err.message);
  }
});

document.addEventListener('click', e => {
  if (e.target.classList && e.target.classList.contains('modal-bg')) {
    e.target.remove();
  }
});

// --- Init auth ---
async function initAuth() {
  if (!supa) {
    authReady = true;
    loginScreen('No se cargaron las bibliotecas. Abre la app conectado una vez para preparar el modo offline.');
    return;
  }
  try {
    // getSession recupera la sesión local sin exigir red. NO solicita credenciales nuevas.
    const local = await supa.auth.getSession();
    const savedUser = local.data?.session?.user || null;
    currentUser = savedUser;
    if (navigator.onLine) {
      try {
        const verified = await supa.auth.getUser();
        if (!verified.error && verified.data?.user) currentUser = verified.data.user;
      } catch (e) { console.warn('Sin validación de red, solo consulta local', e); }
    }
  } catch (e) { console.warn('No se pudo recuperar la sesión local', e); currentUser = null; }
  authReady = true;
  await refresh();
  supa.auth.onAuthStateChange((event, session) => {
    // Evita borrar la biblioteca local ante fallos temporales de conexión.
    if (!navigator.onLine && event !== 'SIGNED_OUT') return;
    if (event === 'SIGNED_OUT') {
      currentUser = null;
      songs = []; services = []; artists = [];
      render();
      return;
    }
    const old = currentUser?.id;
    currentUser = session?.user ?? currentUser;
    if (old !== currentUser?.id) refresh();
    else render();
  });
}

// Precarga de recursos para abrir la interfaz offline, incluidos los CDN usados.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW no disponible', e));
  });
}
initAuth();
