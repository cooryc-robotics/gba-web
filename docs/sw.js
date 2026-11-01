/* sw.js — jugar sin conexión (Premium).
 *
 * Solo se instala cuando el usuario activa el modo sin conexión en este
 * dispositivo. Guarda la web (página, emulador) para poder abrirla sin red.
 * Siempre se intenta primero la red, así los cambios se ven al momento; la
 * copia solo se usa si no hay conexión. Los juegos los guarda app.js en la
 * caché 'gba-roms'; la API nunca pasa por aquí.
 */

const SHELL = 'gba-shell';
const FILES = ['./', 'app.js', 'gb.js', 'gb.wasm', 'gb-audio-worklet.js'];
const NET_TIMEOUT_MS = 3000;
const SCOPE =new URL(self.registration.scope);
const SHELL_URLS = new Set(FILES.map((f) => new URL(f, SCOPE).href));

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== SCOPE.origin) return;
  // La página se pide con parámetros a veces (?pago=…): se guarda una sola.
  const key = req.mode === 'navigate' ? new URL('./', SCOPE).href : url.origin + url.pathname;
  if (!SHELL_URLS.has(key)) return;

  const net = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      ev.waitUntil(caches.open(SHELL).then((c) => c.put(key, copy)));
    }
    return res;
  });
  ev.waitUntil(net.catch(() => {}));

  ev.respondWith((async () => {
    // Con cobertura mala la red puede no contestar nunca (y no fallar):
    // pasado un rato se usa la copia del dispositivo.
    const timeout = new Promise((resolve) => setTimeout(resolve, NET_TIMEOUT_MS, null));
    try {
      const res = await Promise.race([net, timeout]);
      if (res) return res;
    } catch (err) { /* sin conexión */ }
    const cached = await caches.match(key);
    return cached || net;
  })());
});
