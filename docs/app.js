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
  let lastSavedB64 = null;  // para no reescribir localStorage si no ha cambiado nada

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

  function buildMenu(list) {
    menuList.innerHTML = '';
    setMenuStatus(list.length ? '' : 'No hay juegos en el servidor: carga uno de tu dispositivo.');
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
      if (loadRom(buf, key)) {
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

  function loadRom(buf, key) {
    const ptr = Module._em_alloc_rom(buf.length);
    Module.HEAPU8.set(buf, ptr);

    // La partida guardada (si hay) tiene que estar en su sitio antes de arrancar.
    setupSaveSlot(key, buf.length);

    const gb = isGbFile(key);
    const err = Module._em_start(gb ? 1 : 0);
    if (err !== 0) {
      setMenuStatus('No se pudo cargar el ROM (código ' + err + ')', true);
      return false;
    }
    applyVideoSize(gb);

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

    Module._em_stop();
    saveKey = null;
    const led = document.getElementById('led');
    if (led) led.classList.remove('on');

    setMenuStatus('');
    menu.classList.remove('hidden');
  }

  if (menuBtn) menuBtn.addEventListener('click', goToMenu);

  /* ---- Guardado de partidas en localStorage ---- */
  // mGBA usa un bloque de 128 KiB para cualquier tipo de guardado (SRAM,
  // Flash, EEPROM). Solo se escribe en localStorage cuando el juego lo cambia.

  function setupSaveSlot(fileName, romSize) {
    saveKey = 'gbasave::' + fileName + '::' + romSize;
    lastSavedB64 = null;

    const stored = localStorage.getItem(saveKey);
    if (stored) {
      const bytes = base64ToU8(stored);
      if (bytes.length === Module._em_get_save_size()) {
        Module.HEAPU8.set(bytes, Module._em_get_save_ptr());
        lastSavedB64 = stored;
      }
    }
  }

  function saveNow() {
    if (!Module || !saveKey) return;
    if (!Module._em_save_changed()) return; // el juego no ha tocado la partida

    const size = Module._em_get_save_size();
    const ptr = Module._em_get_save_ptr();
    const b64 = u8ToBase64(new Uint8Array(Module.HEAPU8.buffer, ptr, size));
    if (b64 === lastSavedB64) return;
    try {
      localStorage.setItem(saveKey, b64);
    } catch (err) {
      // Sin espacio o almacenamiento bloqueado (p. ej. navegación privada):
      // avisamos y lo reintentamos en el próximo autoguardado.
      showToast('No se pudo guardar la partida (' + (err.name || err) + ')', true);
      return;
    }
    lastSavedB64 = b64;
    showToast('Partida guardada');
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
    if (document.hidden) saveNow();
  });
  window.addEventListener('pagehide', saveNow);

  // Velocidad real de una Game Boy Advance: 59.7275 fps (no 60 en punto). Si atamos
  // el emulador directamente a requestAnimationFrame, la velocidad del
  // juego queda ligada a la frecuencia de refresco real de la pantalla —
  // y muchos móviles la reducen a 30Hz (ahorro de batería, "modo
  // adaptable", etc.), lo que se nota como cámara lenta a la mitad de
  // velocidad. Usamos un reloj real (performance.now) para decidir cuántos
  // frames de GBA toca correr, independientemente de a qué frecuencia
  // vaya la pantalla.
  const GB_FRAME_MS = 1000 / 59.7275;
  const MAX_FRAMES_PER_TICK = 8; // margen suficiente para cuando el modo rapido duplica las que hacen falta por tick
  let lastTime = null;
  let accumulator = 0;
  let fastMode = false;

  function frame(now) {
    if (!running) return;

    if (lastTime === null) lastTime = now;
    let elapsed = now - lastTime;
    lastTime = now;

    // Si ha pasado muchísimo tiempo (pestaña en segundo plano, móvil
    // bloqueado, etc.) no lo intentamos recuperar todo de golpe.
    if (elapsed > 1000) elapsed = GB_FRAME_MS;
    accumulator += elapsed;

    // Modo rápido: al doble de velocidad simplemente exigimos la mitad de
    // tiempo real por cada frame de Game Boy que toca correr.
    const frameMs = fastMode ? GB_FRAME_MS / 2 : GB_FRAME_MS;

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
    if (e.target.closest && e.target.closest('#menu')) return;
    e.preventDefault();
  }, { passive: false });

  /* ---- Toggle de modo rápido (x2) ---- */
  const fastToggle = document.getElementById('fast-toggle');
  if (fastToggle) {
    fastToggle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      if (!audioUnlocked) {
        audioUnlocked = true;
        initAudio();
      }
      fastMode = !fastMode;
      fastToggle.classList.toggle('on', fastMode);
    });
  }
})();
