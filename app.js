/* app.js — pega el núcleo WASM de mGBA (gb.js/gb.wasm) con el DOM.
 *
 * Juega a Game Boy Advance (.gba), Game Boy (.gb) y Game Boy Color (.gbc).
 * Al abrir la web se muestra un menú con los juegos de roms.json; el botón
 * MENU permite volver a él para cambiar de juego.
 */

(() => {
  const ROMS_URL = 'roms.json';
  // Si no hay roms.json se intenta con un único ROM llamado rom.gba.
  const FALLBACK_ROMS = [{ title: 'Juego', file: 'rom.gba' }];
  let W = 240, H = 160; // tamaño de pantalla del juego actual

  const canvas = document.getElementById('gb-canvas');
  const ctx = canvas.getContext('2d');
  const menu = document.getElementById('menu');
  const menuList = document.getElementById('menu-list');
  const menuStatus = document.getElementById('menu-status');
  const menuBtn = document.getElementById('menu-btn');
  const menuLocal = document.getElementById('menu-local');
  const menuLocalTitle = document.getElementById('menu-local-title');
  const menuLoad = document.getElementById('menu-load');
  const menuFile = document.getElementById('menu-file');

  let Module = null;
  let running = false;
  let rafHandle = 0;
  let starting = false;
  let imageData = ctx.createImageData(W, H);
  let saveKey = null;       // clave localStorage del save actual
  let cloudKey = null;      // clave del save actual en el servidor
  let lastSavedB64 = null;  // para no reescribir localStorage si no ha cambiado nada
  let currentUser = null;   // { id, username } con la sesión iniciada

  function setMenuStatus(msg, isError) {
    menuStatus.textContent = msg || '';
    menuStatus.classList.toggle('error', !!isError);
    if (isError) console.error(msg);
  }

  async function loadRomList() {
    try {
      const r = await fetch(ROMS_URL, { cache: 'no-cache' });
      if (r.ok) {
        const list = await r.json();
        if (Array.isArray(list)) {
          return list.filter((e) => e && typeof e.file === 'string');
        }
      }
    } catch (e) { /* sin roms.json: probamos el ROM suelto */ }
    // Sin roms.json: solo ofrecemos el ROM suelto si existe de verdad.
    try {
      const r = await fetch(FALLBACK_ROMS[0].file, { method: 'HEAD' });
      if (r.ok) return FALLBACK_ROMS;
    } catch (e) { /* nada */ }
    return [];
  }

  Promise.all([createGBModule(), loadRomList()])
    .then(([mod, list]) => {
      Module = mod;
      buildMenu(list);
      refreshLocal();
    })
    .catch((err) => setMenuStatus('No se pudo iniciar el emulador: ' + err, true));

  /* ---- Cuenta de usuario ---- */
  // Las partidas se guardan en el servidor (api/) asociadas al usuario, con
  // una copia en localStorage por si se pierde la conexión.

  const loginEl = document.getElementById('login');
  const loginForm = document.getElementById('login-form');
  const loginUser = document.getElementById('login-user');
  const loginPass = document.getElementById('login-pass');
  const loginSubmit = document.getElementById('login-submit');
  const loginToggle = document.getElementById('login-toggle');
  const loginStatus = document.getElementById('login-status');
  const menuUser = document.getElementById('menu-user');
  let registering = false;

  // Llamada a la API. La cabecera X-GBA marca las peticiones como nuestras.
  function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'X-GBA': '1' }, opts.headers || {});
    return fetch('api/' + path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, opts, { headers }));
  }

  function setUser(user) {
    currentUser = user;
    loginEl.classList.toggle('hidden', !!user);
    menuUser.classList.toggle('hidden', !user);
    document.getElementById('menu-username').textContent = user
      ? (user.premium ? '★ ' : '') + 'Sesión: ' + user.username : '';
    applyTheme(user && user.premium ? user.theme : null);
    renderPremium();
    renderAd();
    if (user) renderSaves();
  }

  /* ---- Anuncios: banda inferior del menú para cuentas gratis ----
   * Con AdSense configurado en el servidor se muestra su anuncio; si no,
   * un aviso propio para pasarse a Premium. Nunca durante la partida. */

  const stripEl = document.getElementById('menu-strip');
  let adsConfig = null;   // { client, slot } que manda auth.php
  let adLoaded = false;

  function renderAd() {
    const show = !!currentUser && !currentUser.premium;
    stripEl.classList.toggle('hidden', !show);
    menu.classList.toggle('with-strip', show);
    if (!show || adLoaded) return;
    stripEl.innerHTML = '';
    if (adsConfig && adsConfig.client && adsConfig.slot) {
      adLoaded = true;
      const s = document.createElement('script');
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(adsConfig.client);
      document.head.appendChild(s);
      const ins = el('ins', 'adsbygoogle');
      ins.style.cssText = 'display:inline-block;width:320px;height:50px';
      ins.dataset.adClient = adsConfig.client;
      ins.dataset.adSlot = adsConfig.slot;
      stripEl.appendChild(ins);
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      return;
    }
    const b = el('button', 'strip-promo');
    b.innerHTML = 'Quita los anuncios y desbloquea los extras · <b>Premium 4,99 €</b>';
    b.addEventListener('click', () => premiumBox.scrollIntoView({ behavior: 'smooth' }));
    stripEl.appendChild(b);
  }

  /* ---- Premium: pago único con Mollie (enlaces de pago de Qonto) ---- */

  const premiumBox = document.getElementById('premium-box');
  const THEMES = [
    ['indigo', 'Índigo'], ['atomic', 'Atomic'], ['kiwi', 'Kiwi'],
    ['coral', 'Coral'], ['black', 'Negro'], ['gold', 'Oro'],
  ];

  function applyTheme(theme) {
    if (theme && theme !== 'indigo') document.body.dataset.theme = theme;
    else delete document.body.dataset.theme;
  }

  function renderPremium() {
    premiumBox.innerHTML = '';
    if (!currentUser) return;
    if (!currentUser.premium) {
      premiumBox.className = 'premium-card';
      premiumBox.appendChild(el('h2', null, 'Premium · 4,99 € (pago único)'));
      const ul = el('ul');
      [
        'Sin anuncios',
        'Partidas en la nube de todos tus juegos (gratis: 3)',
        'Estados rápidos: guarda y carga en cualquier momento, en la nube',
        'Historial de las últimas 10 partidas de cada juego',
        'Exportar e importar partidas .sav',
        'Velocidad x4 (además de x2)',
        'Trucos (GameShark, Action Replay, CodeBreaker, Game Genie)',
        'Mandos Bluetooth / USB',
        'Temas de colores para la consola',
      ].forEach((t) => ul.appendChild(el('li', null, t)));
      premiumBox.appendChild(ul);
      const buy = el('button', 'menu-item buy-btn', 'Hazte Premium por 4,99 €');
      buy.addEventListener('click', () => startPayment(buy));
      premiumBox.appendChild(buy);
      return;
    }
    premiumBox.className = 'premium-card is-premium';
    premiumBox.appendChild(el('h2', null, '★ Eres Premium'));
    premiumBox.appendChild(el('p', 'premium-sub', 'Color de la consola'));
    const row = el('div', 'theme-row');
    THEMES.forEach(([id, label]) => {
      const b = el('button', 'theme-chip' + ((currentUser.theme || 'indigo') === id ? ' on' : ''), label);
      b.dataset.themeChip = id;
      b.addEventListener('click', () => chooseTheme(id));
      row.appendChild(b);
    });
    premiumBox.appendChild(row);
  }

  async function chooseTheme(id) {
    applyTheme(id);
    currentUser.theme = id;
    renderPremium();
    try {
      await api('auth.php?action=settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: id }),
      });
    } catch (e) { /* se queda aplicado en esta sesión */ }
  }

  async function startPayment(btn) {
    btn.disabled = true;
    try {
      const r = await api('pay.php', { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
      location.href = data.url;
    } catch (e) {
      showToast('No se pudo iniciar el pago (' + (e.message || e) + ')', true);
      btn.disabled = false;
    }
  }

  // Vuelta de la pasarela (vuelve igual si se paga o se cancela): el
  // servidor consulta el pago a Mollie hasta que deja de estar pendiente.
  async function handlePaymentReturn() {
    if (!new URLSearchParams(location.search).get('pago')) return;
    history.replaceState(null, '', location.pathname);
    showToast('Confirmando el pago…');
    for (let i = 0; i < 15; i++) {
      try {
        const data = await (await api('pay.php')).json();
        if (data.premium) {
          const me = await (await api('auth.php')).json();
          if (me.user) setUser(me.user);
          showToast('¡Gracias! Ya eres Premium');
          return;
        }
        if (data.status === 'failed' || data.status === 'none') {
          showToast('El pago no se ha completado', true);
          return;
        }
      } catch (e) { /* reintenta */ }
      await new Promise((res) => setTimeout(res, 2000));
    }
    showToast('El pago está tardando en confirmarse. Recarga la página en un rato.', true);
  }

  document.getElementById('delete-account').addEventListener('click', async () => {
    const password = window.prompt('Se borrarán tu cuenta y todas tus partidas, estados y trucos. No se puede deshacer.\n\nEscribe tu contraseña para confirmar:');
    if (!password) return;
    try {
      const r = await api('auth.php?action=delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
      setLoginMode(false);
      setUser(null);
      showToast('Cuenta borrada');
    } catch (e) {
      showToast('No se pudo borrar la cuenta (' + (e.message || e) + ')', true);
    }
  });

  function setLoginMode(reg) {
    registering = reg;
    loginSubmit.textContent = reg ? 'Crear cuenta' : 'Entrar';
    loginToggle.textContent = reg ? 'Ya tengo cuenta' : 'Crear cuenta nueva';
    loginPass.autocomplete = reg ? 'new-password' : 'current-password';
    loginPass.placeholder = reg ? 'Contraseña (mínimo 8 caracteres)' : 'Contraseña';
    loginStatus.textContent = '';
  }

  loginToggle.addEventListener('click', () => setLoginMode(!registering));

  loginForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    loginStatus.textContent = '';
    loginSubmit.disabled = true;
    try {
      const r = await api('auth.php?action=' + (registering ? 'register' : 'login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUser.value.trim(), password: loginPass.value }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Error ' + r.status);
      loginPass.value = '';
      setUser(data.user);
    } catch (err) {
      loginStatus.textContent = err.message || String(err);
    }
    loginSubmit.disabled = false;
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await api('auth.php?action=logout', { method: 'POST' }); } catch (e) { /* se cierra igualmente aquí */ }
    setLoginMode(false);
    setUser(null);
  });

  api('auth.php')
    .then((r) => r.json())
    .then((data) => {
      adsConfig = data.ads || null;
      setUser(data.user || null);
      if (data.user) handlePaymentReturn();
    })
    .catch(() => {
      setUser(null);
      loginStatus.textContent = 'No se puede conectar con el servidor';
    });

  function buildMenu(list) {
    menuList.innerHTML = '';
    setMenuStatus(list.length ? '' : 'Carga un juego (.gba, .gb o .gbc) desde tu dispositivo.');
    list.forEach((entry) => {
      const btn = document.createElement('button');
      btn.className = 'menu-item';
      btn.textContent = entry.title || entry.file;
      btn.addEventListener('click', () => startGame(entry));
      menuList.appendChild(btn);
    });
  }

  // Arranca un juego. getBuf() devuelve un Uint8Array con el ROM; key
  // identifica su partida guardada.
  async function launch(title, getBuf, key) {
    if (starting || !Module) return;
    starting = true;
    initAudio(); // pulsar un juego es el gesto que exigen los navegadores para el audio
    setMenuStatus('Cargando ' + title + '…');
    try {
      const buf = await getBuf();
      if (await loadRom(buf, key)) {
        menu.classList.add('hidden');
        setMenuStatus('');
      }
    } catch (err) {
      setMenuStatus('No se pudo cargar el juego: ' + err, true);
    }
    starting = false;
  }

  function startGame(entry) {
    return launch(entry.title || entry.file, async () => {
      const url = entry.file.split('/').map(encodeURIComponent).join('/');
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status + ' al pedir ' + entry.file);
      return new Uint8Array(await r.arrayBuffer());
    }, entry.file);
  }

  /* ---- Juegos cargados desde el dispositivo (se guardan en IndexedDB) ---- */

  const DB_NAME = 'gba-web';
  let dbPromise = null;

  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error('IndexedDB no disponible'));
        const req = window.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('roms');                      // nombre -> bytes
          req.result.createObjectStore('meta', { keyPath: 'name' }); // nombre, tamaño
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function localList() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const r = db.transaction('meta').objectStore('meta').getAll();
      r.onsuccess = () => resolve(r.result.sort((a, b) => a.name.localeCompare(b.name)));
      r.onerror = () => reject(r.error);
    });
  }

  async function localGet(name) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const r = db.transaction('roms').objectStore('roms').get(name);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  async function localPut(name, arrayBuffer) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['roms', 'meta'], 'readwrite');
      tx.objectStore('roms').put(arrayBuffer, name);
      tx.objectStore('meta').put({ name, size: arrayBuffer.byteLength });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  async function localDelete(name) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['roms', 'meta'], 'readwrite');
      tx.objectStore('roms').delete(name);
      tx.objectStore('meta').delete(name);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  function titleFromName(name) {
    return name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim() || name;
  }

  async function refreshLocal() {
    let items = [];
    try { items = await localList(); } catch (e) { /* sin IndexedDB: no hay lista local */ }

    menuLocal.innerHTML = '';
    menuLocalTitle.classList.toggle('hidden', items.length === 0);
    items.forEach(({ name }) => {
      const row = document.createElement('div');
      row.className = 'menu-row';

      const play = document.createElement('button');
      play.className = 'menu-item';
      play.textContent = titleFromName(name);
      play.addEventListener('click', () => startLocal(name));

      const del = document.createElement('button');
      del.className = 'menu-del';
      del.textContent = '✕';
      del.setAttribute('aria-label', 'Borrar ' + titleFromName(name));
      del.addEventListener('click', () => deleteLocal(name));

      row.appendChild(play);
      row.appendChild(del);
      menuLocal.appendChild(row);
    });
  }

  function startLocal(name) {
    return launch(titleFromName(name), async () => {
      const ab = await localGet(name);
      if (!ab) throw new Error('no se encuentra en este dispositivo');
      return new Uint8Array(ab);
    }, 'local:' + name);
  }

  async function deleteLocal(name) {
    if (!window.confirm('¿Borrar "' + titleFromName(name) + '" de este dispositivo?\n(La partida guardada se conserva.)')) return;
    try { await localDelete(name); } catch (e) { setMenuStatus('No se pudo borrar: ' + e, true); }
    refreshLocal();
  }

  menuLoad.addEventListener('click', () => {
    initAudio(); // dentro del gesto del usuario (política de autoplay)
    menuFile.click();
  });

  menuFile.addEventListener('change', async () => {
    const file = menuFile.files && menuFile.files[0];
    menuFile.value = '';
    if (!file) return;
    if (!/\.(gba|gb|gbc)$/i.test(file.name)) {
      setMenuStatus('Solo se admiten archivos .gba, .gb y .gbc', true);
      return;
    }
    const minSize = isGbFile(file.name) ? 0x150 : 0xC0;
    if (file.size < minSize || file.size > 32 * 1024 * 1024) {
      setMenuStatus('Ese archivo no parece un ROM válido', true);
      return;
    }

    let ab;
    try {
      ab = await file.arrayBuffer();
    } catch (err) {
      setMenuStatus('No se pudo leer el archivo: ' + err, true);
      return;
    }

    // Lo guardamos para que aparezca en el menú la próxima vez.
    try {
      await localPut(file.name, ab);
      await refreshLocal();
    } catch (e) { /* sin IndexedDB se juega igualmente, pero no queda guardado */ }

    launch(titleFromName(file.name), async () => new Uint8Array(ab), 'local:' + file.name);
  });

  // .gb / .gbc usan el núcleo de Game Boy; el resto (.gba), el de GBA.
  function isGbFile(name) {
    return /\.(gb|gbc)$/i.test(name);
  }

  // Ajusta el canvas al tamaño de pantalla del juego (240x160 o 160x144).
  function applyVideoSize(isGb) {
    W = Module._em_fb_width();
    H = Module._em_fb_height();
    canvas.width = W;
    canvas.height = H;
    canvas.style.setProperty('--ar-w', W);
    canvas.style.setProperty('--ar-h', H);
    imageData = ctx.createImageData(W, H);
    document.body.classList.toggle('is-gb', isGb);
  }

  async function loadRom(buf, key) {
    const ptr = Module._em_alloc_rom(buf.length);
    Module.HEAPU8.set(buf, ptr);

    // La partida guardada (si hay) tiene que estar en su sitio antes de arrancar.
    await setupSaveSlot(key, buf.length);

    const gb = isGbFile(key);
    const err = Module._em_start(gb ? 1 : 0);
    if (err !== 0) {
      setMenuStatus('No se pudo cargar el ROM (código ' + err + ')', true);
      return false;
    }
    applyVideoSize(gb);
    loadCheatsForGame();

    const led = document.getElementById('led');
    if (led) led.classList.add('on');

    running = true;
    lastTime = null;
    accumulator = 0;
    cancelAnimationFrame(rafHandle);
    rafHandle = requestAnimationFrame(frame);
    return true;
  }

  function goToMenu() {
    if (!Module) return;
    saveNow();
    running = false;
    cancelAnimationFrame(rafHandle);

    // Soltar cualquier botón que quedara pulsado.
    for (let b = 0; b < 10; b++) Module._em_set_button(b, 0);
    document.querySelectorAll('[data-btn].active').forEach((el) => el.classList.remove('active'));
    pointerBtns.clear();
    btnCount.clear();
    padState.fill(false);
    gamePanel.classList.add('hidden');

    Module._em_stop();
    saveKey = null;
    cloudKey = null;
    const led = document.getElementById('led');
    if (led) led.classList.remove('on');

    setMenuStatus('');
    renderSaves();
    menu.classList.remove('hidden');
  }

  if (menuBtn) menuBtn.addEventListener('click', goToMenu);

  /* ---- Guardado de partidas: servidor + copia en localStorage ---- */
  // mGBA usa un bloque de 128 KiB para cualquier tipo de guardado (SRAM,
  // Flash, EEPROM). Cuando el juego lo cambia se guarda en localStorage y se
  // sube a la cuenta del usuario. Si la subida falla, la copia local queda
  // marcada como pendiente y gana sobre la del servidor la próxima vez.

  let uploading = false;
  let nextUpload = null;
  let cloudFull = false; // la cuenta gratis ya tiene el máximo de juegos en la nube

  function pendingKey() { return 'gbapending::' + saveKey; }

  // Clave de un juego en el servidor: nombre del archivo + tamaño, sin
  // importar si se cargó del dispositivo o de la lista del servidor.
  function gameCloudKey(fileName, romSize) {
    return fileName.replace(/^(roms\/|local:)/, '') + '::' + romSize;
  }

  async function setupSaveSlot(fileName, romSize) {
    cloudKey = gameCloudKey(fileName, romSize);
    saveKey = 'gbasave::' + (currentUser ? currentUser.id : 0) + '::' + cloudKey;
    lastSavedB64 = null;
    cloudFull = false;
    const size = Module._em_get_save_size();

    let local = null, pending = false;
    try {
      local = localStorage.getItem(saveKey);
      pending = localStorage.getItem(pendingKey()) === '1';
    } catch (e) { /* sin localStorage: solo servidor */ }

    let bytes = null;
    if (local && pending) {
      bytes = base64ToU8(local); // cambios que no llegaron a subirse
    } else {
      try {
        const r = await api('saves.php?key=' + encodeURIComponent(cloudKey));
        if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
        else if (r.status !== 404) throw new Error('HTTP ' + r.status);
        else if (local) { bytes = base64ToU8(local); pending = true; } // aún no está en la nube
      } catch (err) {
        if (local) bytes = base64ToU8(local);
        showToast('Sin conexión: se usa la copia de este dispositivo', true);
      }
    }

    if (bytes && bytes.length <= size) {
      // En el servidor se guarda sin los 0xFF del final: se rellenan aquí.
      const full = new Uint8Array(size).fill(0xFF);
      full.set(bytes);
      Module.HEAPU8.set(full, Module._em_get_save_ptr());
      lastSavedB64 = u8ToBase64(full);
    }
    if (pending) uploadSave();
  }

  function saveNow(isLeaving) {
    if (!Module || !saveKey) return;
    if (!Module._em_save_changed()) return; // el juego no ha tocado la partida

    const size = Module._em_get_save_size();
    const ptr = Module._em_get_save_ptr();
    const b64 = u8ToBase64(new Uint8Array(Module.HEAPU8.buffer, ptr, size));
    if (b64 === lastSavedB64) return;
    lastSavedB64 = b64;
    try {
      localStorage.setItem(saveKey, b64);
      localStorage.setItem(pendingKey(), '1');
    } catch (e) { /* sin localStorage: depende solo de la subida */ }
    if (cloudFull) {
      if (isLeaving !== true) showToast('Partida guardada en este dispositivo');
      return;
    }
    uploadSave(isLeaving === true);
  }

  // Quita los 0xFF del final (zona sin usar del bloque) para subir menos.
  function trimmedSave(b64) {
    const u8 = base64ToU8(b64);
    let end = u8.length;
    while (end > 0 && u8[end - 1] === 0xFF) end--;
    return u8.slice(0, end);
  }

  // Sube la partida actual. Si ya hay una subida en marcha, la última
  // versión queda en cola (con sus claves, por si se vuelve al menú).
  async function uploadSave(isLeaving, job) {
    job = job || (saveKey && lastSavedB64 ? { key: saveKey, cloud: cloudKey, b64: lastSavedB64 } : null);
    if (!job) return;
    if (uploading && !isLeaving) { nextUpload = job; return; }
    uploading = true;
    const { key, cloud, b64 } = job;
    const body = trimmedSave(b64);
    try {
      const r = await api('saves.php?key=' + encodeURIComponent(cloud), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
        // Al cerrar la página solo sobrevive una petición keepalive (máx. 64 KiB).
        keepalive: !!isLeaving && body.length <= 60000,
      });
      if (r.status === 401) throw new Error('la sesión ha caducado');
      if (r.status === 402) {
        // Límite de la cuenta gratis: se sigue guardando en el dispositivo.
        cloudFull = true;
        const data = await r.json().catch(() => ({}));
        throw new Error((data.error || 'límite de la cuenta gratis') + '. Con Premium se guardan todos');
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      try {
        if (localStorage.getItem(key) === b64) localStorage.removeItem('gbapending::' + key);
      } catch (e) { /* nada */ }
      if (!isLeaving) showToast('Partida guardada');
    } catch (err) {
      if (!isLeaving) showToast('Guardada solo en este dispositivo (' + (err.message || err) + ')', true);
    }
    uploading = false;
    if (nextUpload) { const next = nextUpload; nextUpload = null; uploadSave(false, next); }
  }

  // Reintenta de vez en cuando lo que no se pudo subir.
  setInterval(() => {
    try {
      if (saveKey && !uploading && !cloudFull && localStorage.getItem(pendingKey()) === '1') uploadSave();
    } catch (e) { /* nada */ }
  }, 30000);

  /* ---- Mis partidas: lista de la nube, exportar/importar .sav, historial ---- */

  const savesList = document.getElementById('saves-list');
  const savFile = document.getElementById('sav-file');
  let importKey = null; // juego al que va el .sav que se está importando

  function gameName(key) {
    return key.slice(0, key.lastIndexOf('::')).replace(/^(roms\/|local:)/, '').replace(/\.(gba|gbc|gb)$/i, '');
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function premiumOnly() {
    if (currentUser && currentUser.premium) return true;
    showToast('Función Premium', true);
    document.getElementById('premium-box').scrollIntoView({ behavior: 'smooth' });
    return false;
  }

  // Al cambiar la partida desde el menú, la copia local de ese juego deja de valer.
  function forgetLocalSave(key) {
    try {
      const k = 'gbasave::' + currentUser.id + '::' + key;
      localStorage.removeItem(k);
      localStorage.removeItem('gbapending::' + k);
    } catch (e) { /* nada */ }
  }

  async function renderSaves() {
    const info = document.getElementById('menu-saves');
    if (!info || !currentUser) return;
    savesList.innerHTML = '';
    try {
      const r = await api('saves.php');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const { saves, limit } = await r.json();
      info.textContent = !saves.length
        ? 'Aún no hay partidas guardadas en tu cuenta.'
        : limit ? saves.length + ' de ' + limit + ' juegos en la nube (cuenta gratis).' : '';
      saves.forEach((s) => savesList.appendChild(saveRow(s)));
    } catch (e) {
      info.textContent = 'No se pudo consultar las partidas guardadas (' + (e.message || e) + ').';
    }
  }

  function saveRow(s) {
    const row = el('div', 'save-row');
    const head = el('div', 'save-head');
    head.appendChild(el('span', 'save-name', gameName(s.key)));
    head.appendChild(el('span', 'save-date', new Date(s.updated_at).toLocaleString()));
    row.appendChild(head);

    const actions = el('div', 'save-actions');
    const exp = el('button', 'chip', 'Exportar .sav');
    exp.addEventListener('click', () => premiumOnly() && exportSave(s.key));
    const imp = el('button', 'chip', 'Importar .sav');
    imp.addEventListener('click', () => {
      if (!premiumOnly()) return;
      importKey = s.key;
      savFile.click();
    });
    const hist = el('button', 'chip', 'Historial');
    const histBox = el('div', 'save-history hidden');
    hist.addEventListener('click', () => premiumOnly() && toggleHistory(s.key, histBox));
    [exp, imp, hist].forEach((b) => actions.appendChild(b));
    row.appendChild(actions);
    row.appendChild(histBox);
    return row;
  }

  // Tamaños estándar de partida (EEPROM, SRAM, Flash): el .sav exportado se
  // rellena hasta el primero que quepa, que es lo que esperan otros emuladores.
  const SAV_SIZES = [512, 8192, 32768, 65536, 131072];

  async function exportSave(key) {
    try {
      const r = await api('saves.php?key=' + encodeURIComponent(key));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = new Uint8Array(await r.arrayBuffer());
      const size = SAV_SIZES.find((n) => n >= data.length) || data.length;
      const out = new Uint8Array(size).fill(0xFF);
      out.set(data);
      const a = el('a');
      a.href = URL.createObjectURL(new Blob([out], { type: 'application/octet-stream' }));
      a.download = gameName(key) + '.sav';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) {
      showToast('No se pudo exportar (' + (e.message || e) + ')', true);
    }
  }

  async function putSave(key, bytes) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0xFF) end--;
    const r = await api('saves.php?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes.slice(0, end),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || 'HTTP ' + r.status);
    }
    forgetLocalSave(key);
  }

  savFile.addEventListener('change', async () => {
    const file = savFile.files && savFile.files[0];
    savFile.value = '';
    if (!file || !importKey) return;
    if (file.size > 131072) { showToast('Ese archivo es demasiado grande para ser una partida', true); return; }
    if (!window.confirm('¿Sustituir la partida de "' + gameName(importKey) + '" por ' + file.name + '?')) return;
    try {
      await putSave(importKey, new Uint8Array(await file.arrayBuffer()));
      showToast('Partida importada');
      renderSaves();
    } catch (e) {
      showToast('No se pudo importar (' + (e.message || e) + ')', true);
    }
  });

  async function toggleHistory(key, box) {
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.textContent = 'Cargando…';
    try {
      const r = await api('saves.php?history=1&key=' + encodeURIComponent(key));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const { versions } = await r.json();
      box.textContent = versions.length ? '' : 'Todavía no hay versiones anteriores.';
      versions.forEach((v) => {
        const line = el('div', 'history-row');
        line.appendChild(el('span', null, new Date(v.saved_at).toLocaleString()));
        const btn = el('button', 'chip', 'Restaurar');
        btn.addEventListener('click', () => restoreVersion(key, v));
        line.appendChild(btn);
        box.appendChild(line);
      });
    } catch (e) {
      box.textContent = 'No se pudo cargar el historial (' + (e.message || e) + ').';
    }
  }

  async function restoreVersion(key, v) {
    if (!window.confirm('¿Volver a la partida del ' + new Date(v.saved_at).toLocaleString() + '?\n(La actual quedará en el historial.)')) return;
    try {
      const r = await api('saves.php?key=' + encodeURIComponent(key) + '&version=' + v.id);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      await putSave(key, new Uint8Array(await r.arrayBuffer()));
      showToast('Partida restaurada');
      renderSaves();
    } catch (e) {
      showToast('No se pudo restaurar (' + (e.message || e) + ')', true);
    }
  }

  const saveToast = document.getElementById('save-toast');
  let saveToastTimer = null;
  function showToast(msg, isError) {
    if (isError) console.error(msg);
    if (!saveToast) return;
    saveToast.textContent = msg;
    saveToast.classList.toggle('error', !!isError);
    saveToast.classList.add('show');
    clearTimeout(saveToastTimer);
    saveToastTimer = setTimeout(() => saveToast.classList.remove('show'), isError ? 5000 : 1500);
  }

  // Pide al navegador que no borre los datos de la web por falta de espacio
  // o inactividad (Safari los borra a los 7 días si no se concede).
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  function u8ToBase64(u8) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToU8(b64) {
    const binary = atob(b64);
    const u8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
    return u8;
  }

  // Autoguardado periódico (solo escribe si cambió algo) y al perder foco / cerrar.
  setInterval(saveNow, 3000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveNow(true);
  });
  window.addEventListener('pagehide', () => saveNow(true));

  // Velocidad real de una Game Boy Advance: 59.7275 fps (no 60 en punto). Si atamos
  // el emulador directamente a requestAnimationFrame, la velocidad del
  // juego queda ligada a la frecuencia de refresco real de la pantalla —
  // y muchos móviles la reducen a 30Hz (ahorro de batería, "modo
  // adaptable", etc.), lo que se nota como cámara lenta a la mitad de
  // velocidad. Usamos un reloj real (performance.now) para decidir cuántos
  // frames de GBA toca correr, independientemente de a qué frecuencia
  // vaya la pantalla.
  const GB_FRAME_MS = 1000 / 59.7275;
  const MAX_FRAMES_PER_TICK = 12; // margen para x4 con pantallas a 30 Hz
  let lastTime = null;
  let accumulator = 0;
  let fastMode = false;
  let speed = 1; // 1, 2 o 4

  function frame(now) {
    if (!running) return;
    pollGamepads();

    if (lastTime === null) lastTime = now;
    let elapsed = now - lastTime;
    lastTime = now;

    // Si ha pasado muchísimo tiempo (pestaña en segundo plano, móvil
    // bloqueado, etc.) no lo intentamos recuperar todo de golpe.
    if (elapsed > 1000) elapsed = GB_FRAME_MS;
    accumulator += elapsed;

    // Modo rápido: a x2 (o x4) simplemente exigimos la mitad (o la cuarta
    // parte) de tiempo real por cada frame de Game Boy que toca correr.
    const frameMs = GB_FRAME_MS / speed;

    let framesRun = 0;
    while (accumulator >= frameMs && framesRun < MAX_FRAMES_PER_TICK) {
      Module._em_run_frame();
      // En modo rápido el audio se silencia (si no, sale un pitido agudo
      // tipo "ardilla" al acelerarlo al doble) — se recupera solo al
      // desactivar el modo rápido.
      if (!fastMode) pushAudio();
      accumulator -= frameMs;
      framesRun++;
    }
    if (framesRun > 0) blit();

    rafHandle = requestAnimationFrame(frame);
  }

  function blit() {
    const ptr = Module._em_get_framebuffer();
    // Vista fresca cada frame: con ALLOW_MEMORY_GROWTH el buffer puede
    // haberse reemplazado por otro más grande.
    const src = new Uint32Array(Module.HEAPU8.buffer, ptr, W * H);
    new Uint32Array(imageData.data.buffer).set(src);
    ctx.putImageData(imageData, 0, 0);
  }

  /* ---- Audio ---- */
  // AudioWorklet en su propio hilo real de audio: el hilo principal (donde
  // corre el emulador) solo empuja un trozo de muestras por frame.
  let audioCtx = null;
  let gbAudioNode = null;

  function initAudio() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return;
    }
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
      if (!audioCtx.audioWorklet) throw new Error('AudioWorklet no disponible (¿http sin localhost?)');
      audioCtx.audioWorklet.addModule('gb-audio-worklet.js').then(() => {
        gbAudioNode = new AudioWorkletNode(audioCtx, 'gb-audio-processor', {
          outputChannelCount: [2],
        });
        gbAudioNode.connect(audioCtx.destination);
      });
    } catch (err) {
      // Sin audio, pero el juego sigue siendo jugable igualmente.
      console.warn('Audio no disponible:', err);
    }
  }

  function pushAudio() {
    if (!gbAudioNode) return;

    const frames = Module._em_get_audio_frames(); // pares L/R a 44100 Hz
    if (frames === 0) return;
    const ptr = Module._em_get_audio_buffer();
    const samples = new Int16Array(Module.HEAPU8.buffer, ptr, frames * 2);

    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      left[i] = samples[i * 2] / 32768;
      right[i] = samples[i * 2 + 1] / 32768;
    }

    gbAudioNode.port.postMessage({ left, right }, [left.buffer, right.buffer]);
  }

  /* ---- Controles táctiles ---- */
  // Cada dedo (pointerId) pisa un conjunto de botones (uno, o dos en las
  // diagonales de la cruceta). Al deslizar el dedo se recalcula ese conjunto:
  // suelta lo que ya no pisa y pulsa lo nuevo (p. ej. pasar de derecha a
  // arriba sin levantar el dedo). Un botón sólo se suelta cuando ningún dedo
  // lo pisa.
  const pointerBtns = new Map(); // pointerId -> Set<btnElement>
  const btnCount = new Map();    // btnElement -> nº de dedos encima
  let audioUnlocked = false;

  const dpadEl = document.getElementById('dpad');
  // Las 8 direcciones de la cruceta, en sectores de 45° empezando por la
  // derecha y girando en sentido horario (el eje Y de pantalla va hacia abajo).
  const DPAD_SECTORS = [
    ['dpad-right'], ['dpad-right', 'dpad-down'], ['dpad-down'], ['dpad-down', 'dpad-left'],
    ['dpad-left'], ['dpad-left', 'dpad-up'], ['dpad-up'], ['dpad-up', 'dpad-right'],
  ].map((ids) => ids.map((id) => document.getElementById(id)));
  const DPAD_DEADZONE = 0.12; // radio muerto en el centro, en fracción del ancho

  function btnsAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !hit.closest) return [];
    // En la cruceta manda el ángulo respecto al centro, no el botón que haya
    // debajo, para que las esquinas den diagonales.
    if (dpadEl && hit.closest('#dpad')) {
      const r = dpadEl.getBoundingClientRect();
      const dx = x - (r.left + r.width / 2);
      const dy = y - (r.top + r.height / 2);
      if (Math.hypot(dx, dy) < r.width * DPAD_DEADZONE) return [];
      const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
      return DPAD_SECTORS[(sector + 8) % 8];
    }
    const btn = hit.closest('[data-btn]');
    return btn ? [btn] : [];
  }

  function pressBtn(el) {
    const n = btnCount.get(el) || 0;
    btnCount.set(el, n + 1);
    if (n > 0) return;
    el.classList.add('active');
    if (Module) Module._em_set_button(parseInt(el.dataset.btn, 10), 1);
  }

  function releaseBtn(el) {
    const n = btnCount.get(el) || 0;
    if (n > 1) { btnCount.set(el, n - 1); return; }
    btnCount.delete(el);
    el.classList.remove('active');
    if (Module) Module._em_set_button(parseInt(el.dataset.btn, 10), 0);
  }

  function setPointerBtns(id, btns) {
    const prev = pointerBtns.get(id) || new Set();
    const next = new Set(btns);
    prev.forEach((el) => { if (!next.has(el)) releaseBtn(el); });
    next.forEach((el) => { if (!prev.has(el)) pressBtn(el); });
    pointerBtns.set(id, next);
  }

  document.addEventListener('pointerdown', (ev) => {
    const btns = btnsAt(ev.clientX, ev.clientY);
    if (!btns.length) return;
    ev.preventDefault();
    if (!audioUnlocked) {
      // El primer toque del usuario en cualquier botón sirve como el
      // "gesto" que los navegadores exigen para permitir reproducir audio.
      audioUnlocked = true;
      initAudio();
    }
    // En táctil el navegador "captura" el dedo en el elemento donde empezó;
    // lo liberamos para poder seguirlo por encima de los demás.
    if (ev.target.hasPointerCapture && ev.target.hasPointerCapture(ev.pointerId)) {
      ev.target.releasePointerCapture(ev.pointerId);
    }
    setPointerBtns(ev.pointerId, btns);
  });

  document.addEventListener('pointermove', (ev) => {
    if (!pointerBtns.has(ev.pointerId)) return;
    setPointerBtns(ev.pointerId, btnsAt(ev.clientX, ev.clientY));
  });

  const endPointer = (ev) => {
    if (!pointerBtns.has(ev.pointerId)) return;
    setPointerBtns(ev.pointerId, []);
    pointerBtns.delete(ev.pointerId);
  };
  document.addEventListener('pointerup', endPointer);
  document.addEventListener('pointercancel', endPointer);

  // Evita el gesto de "pull to refresh" / zoom por doble tap en iOS/Android.
  document.addEventListener('touchmove', (e) => {
    // El menú de juegos necesita poder hacer scroll.
    if (e.target.closest && e.target.closest('#menu, #game-panel, #login')) return;
    e.preventDefault();
  }, { passive: false });

  /* ---- Toggle de modo rápido (x2; con Premium también x4) ---- */
  const fastToggle = document.getElementById('fast-toggle');
  const fastLabel = document.getElementById('fast-label');
  function setSpeed(n) {
    speed = n;
    fastMode = n > 1;
    fastToggle.classList.toggle('on', fastMode);
    fastToggle.classList.toggle('x4', n === 4);
    if (fastLabel) fastLabel.textContent = n === 4 ? '4X' : '2X';
  }
  if (fastToggle) {
    fastToggle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      if (!audioUnlocked) {
        audioUnlocked = true;
        initAudio();
      }
      const premium = currentUser && currentUser.premium;
      setSpeed(speed === 1 ? 2 : speed === 2 && premium ? 4 : 1);
    });
  }

  /* ---- Panel EXTRAS (Premium): estados rápidos y trucos ---- */

  const extrasBtn = document.getElementById('extras-btn');
  const gamePanel = document.getElementById('game-panel');
  const statesList = document.getElementById('states-list');
  const cheatsText = document.getElementById('cheats-text');
  const cheatsStatus = document.getElementById('cheats-status');
  const STATE_SLOTS = 3;

  function pauseGame() {
    running = false;
    cancelAnimationFrame(rafHandle);
  }

  function resumeGame() {
    if (!saveKey || running) return;
    running = true;
    lastTime = null;
    accumulator = 0;
    rafHandle = requestAnimationFrame(frame);
  }

  extrasBtn.addEventListener('click', () => {
    if (!saveKey) return;
    pauseGame();
    const premium = currentUser && currentUser.premium;
    gamePanel.classList.toggle('locked', !premium);
    gamePanel.classList.remove('hidden');
    if (premium) renderStates();
  });

  document.getElementById('panel-close').addEventListener('click', () => {
    gamePanel.classList.add('hidden');
    resumeGame();
  });
  document.getElementById('panel-premium').addEventListener('click', () => {
    gamePanel.classList.add('hidden');
    goToMenu();
    premiumBox.scrollIntoView();
  });

  async function renderStates() {
    statesList.textContent = 'Cargando…';
    let slots = [];
    try {
      const r = await api('states.php?key=' + encodeURIComponent(cloudKey));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      slots = (await r.json()).slots;
    } catch (e) {
      statesList.textContent = 'No se pudieron cargar los estados (' + (e.message || e) + ').';
      return;
    }
    statesList.textContent = '';
    for (let n = 1; n <= STATE_SLOTS; n++) {
      const info = slots.find((s) => s.slot === n);
      const row = el('div', 'state-row');
      row.appendChild(el('span', 'state-name', 'Hueco ' + n));
      row.appendChild(el('span', 'state-date', info ? new Date(info.updated_at).toLocaleString() : 'vacío'));
      const save = el('button', 'chip', 'Guardar');
      save.addEventListener('click', () => saveState(n));
      const load = el('button', 'chip', 'Cargar');
      load.disabled = !info;
      load.addEventListener('click', () => loadState(n));
      row.appendChild(save);
      row.appendChild(load);
      statesList.appendChild(row);
    }
  }

  // Los estados ocupan ~400 KiB; se suben comprimidos con gzip si el
  // navegador lo permite (casi todo es memoria repetida).
  async function gzip(u8, decompress) {
    const Stream = decompress ? window.DecompressionStream : window.CompressionStream;
    if (!Stream) return null;
    const s = new Blob([u8]).stream().pipeThrough(new Stream('gzip'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  async function saveState(n) {
    const size = Module._em_save_state();
    if (!size) { showToast('No se pudo crear el estado', true); return; }
    const ptr = Module._em_state_buffer();
    const raw = Module.HEAPU8.slice(ptr, ptr + size);
    try {
      const body = (await gzip(raw)) || raw;
      const r = await api('states.php?key=' + encodeURIComponent(cloudKey) + '&slot=' + n, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      showToast('Estado ' + n + ' guardado');
      renderStates();
    } catch (e) {
      showToast('No se pudo guardar el estado (' + (e.message || e) + ')', true);
    }
  }

  async function loadState(n) {
    try {
      const r = await api('states.php?key=' + encodeURIComponent(cloudKey) + '&slot=' + n);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      let data = new Uint8Array(await r.arrayBuffer());
      if (data[0] === 0x1f && data[1] === 0x8b) data = await gzip(data, true);
      if (!data || data.length !== Module._em_state_size()) throw new Error('el estado no es de este juego');
      const ptr = Module._em_state_buffer();
      Module.HEAPU8.set(data, ptr);
      if (!Module._em_load_state()) throw new Error('el emulador lo rechazó');
      showToast('Estado ' + n + ' cargado');
      gamePanel.classList.add('hidden');
      resumeGame();
    } catch (e) {
      showToast('No se pudo cargar el estado (' + (e.message || e) + ')', true);
    }
  }

  // Trucos: se guardan por juego en la cuenta y se aplican al arrancar.
  function applyCheats(text) {
    const bytes = new TextEncoder().encode(text.replace(/\r/g, ''));
    const max = Module._em_cheat_text_size() - 1;
    if (bytes.length > max) return -1;
    const ptr = Module._em_cheat_text();
    Module.HEAPU8.set(bytes, ptr);
    Module.HEAPU8[ptr + bytes.length] = 0;
    return Module._em_cheats_apply();
  }

  async function loadCheatsForGame() {
    cheatsText.value = '';
    cheatsStatus.textContent = '';
    if (!currentUser || !currentUser.premium || !cloudKey) return;
    try {
      const r = await api('cheats.php?key=' + encodeURIComponent(cloudKey));
      if (!r.ok) return;
      const { codes } = await r.json();
      cheatsText.value = codes;
      if (codes.trim()) {
        const n = applyCheats(codes);
        cheatsStatus.textContent = n + ' código(s) activos';
      }
    } catch (e) { /* sin trucos */ }
  }

  document.getElementById('cheats-apply').addEventListener('click', async () => {
    const codes = cheatsText.value;
    const n = applyCheats(codes);
    if (n < 0) { cheatsStatus.textContent = 'Demasiados códigos'; return; }
    const lines = codes.split('\n').filter((l) => l.trim()).length;
    cheatsStatus.textContent = codes.trim()
      ? n + ' de ' + lines + ' línea(s) aceptadas' + (n < lines ? ' (revisa el formato de las demás)' : '')
      : 'Trucos desactivados';
    try {
      await api('cheats.php?key=' + encodeURIComponent(cloudKey), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codes }),
      });
    } catch (e) { cheatsStatus.textContent += ' · no se pudieron guardar en tu cuenta'; }
  });

  /* ---- Mandos (Gamepad API, Premium) ---- */
  // Distribución estándar: el botón de la derecha (B de Xbox / círculo) es
  // la A de Game Boy, como en los mandos de Nintendo.
  const PAD_MAP = [
    [1, 0], [0, 1], [8, 2], [9, 3], [15, 4], [14, 5], [12, 6], [13, 7], [5, 8], [4, 9],
  ]; // [botón del mando, botón de Game Boy]
  const padState = new Array(10).fill(false);
  let padNoticed = false;

  function pollGamepads() {
    if (!navigator.getGamepads || !currentUser || !currentUser.premium) return;
    const pads = navigator.getGamepads();
    const now = new Array(10).fill(false);
    let any = false;
    for (const pad of pads) {
      if (!pad) continue;
      any = true;
      PAD_MAP.forEach(([pb, gb]) => { if (pad.buttons[pb] && pad.buttons[pb].pressed) now[gb] = true; });
      const [ax, ay] = pad.axes;
      if (ax > 0.5) now[4] = true;
      if (ax < -0.5) now[5] = true;
      if (ay < -0.5) now[6] = true;
      if (ay > 0.5) now[7] = true;
    }
    if (any && !padNoticed) { padNoticed = true; showToast('Mando conectado'); }
    for (let b = 0; b < 10; b++) {
      if (now[b] !== padState[b]) {
        padState[b] = now[b];
        Module._em_set_button(b, now[b] ? 1 : 0);
      }
    }
  }
})();
