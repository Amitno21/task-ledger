/* Daily Task Ledger — service worker.
   Bump CACHE when you change any shell file, so devices pick the new one up. */
const CACHE = "ledger-v2";

/* The shell: everything needed to open the app with no network at all.
   Task data is not here — Firestore keeps its own copy in IndexedDB. */
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      /* addAll fails the whole install if any one file 404s, so add individually */
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  /* Never cache Firestore/auth traffic — it has its own offline machinery and
     serving it stale would hand back the wrong data. */
  if (/firestore\.googleapis\.com|identitytoolkit|securetoken/.test(url.hostname)) return;

  /* Navigations: try the network so a redeploy lands, fall back to the cached
     shell when offline. */
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || Response.error()))
    );
    return;
  }

  /* Everything else (own assets, fonts, the Firebase SDK): serve from cache
     when we have it, and refresh the copy in the background. */
  e.respondWith(
    caches.match(req).then((hit) => {
      const live = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || live;
    })
  );
});

/* ---------- push notifications ---------- */
/* The daily digest arrives here even when the app is closed. iOS only delivers
   these to a web app that was added to the Home Screen. */
self.addEventListener("push", (e) => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch (_) { payload = {}; }

  const title = payload.title || "Daily Task Ledger";
  const options = {
    body: payload.body || "You have things waiting.",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: payload.tag || "daily-digest",   /* replaces, never stacks */
    renotify: true,
    data: { url: payload.url || "./index.html" }
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

/* Tapping the notification focuses the app if it's already open, opens it if not. */
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "./index.html", self.location.href).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && "focus" in c) return c.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    })
  );
});
