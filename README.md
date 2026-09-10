# Daily Task Ledger — installable app

A progressive web app version of the ledger. Installs to your iPhone home screen with
its own icon, opens full-screen with no browser chrome, works with no signal, and keeps
one list across every device you sign in from.

It works the moment you deploy it. Sync is optional and can be added later — until you
fill in `firebase-config.js`, the app runs in local-only mode and keeps tasks in the
browser on that device.

---

## 1. Put it online (GitHub Pages)

The app is plain static files, so any static host works. GitHub Pages is free.

1. Create a new repository on github.com — call it `task-ledger`. It can be public or
   private (Pages works with private repos on paid plans; use public if you're on free).
2. From this folder, push the `pwa/` contents to it:

```bash
cd pwa && git init && git add . && git commit -m "Daily Task Ledger PWA"
```

```bash
git branch -M main && git remote add origin https://github.com/YOUR_USERNAME/task-ledger.git && git push -u origin main
```

3. On GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `root` → Save**.
4. Wait about a minute. Your app is at `https://YOUR_USERNAME.github.io/task-ledger/`.

HTTPS matters here: service workers and offline support only run on HTTPS (or localhost).
GitHub Pages gives you HTTPS automatically.

---

## 2. Install it on your iPhone

1. Open the Pages URL in **Safari** (not Chrome — only Safari can install to the home
   screen on iOS).
2. Tap the **Share** button, then **Add to Home Screen**.
3. It appears as **Ledger** with its own icon and opens full-screen.

Do the same on any other device you want it on.

---

## 3. Add sync across devices (optional)

Without this, each device keeps its own list. This step gives you one shared list.

### Create the backend

1. Go to <https://console.firebase.google.com> and **Add project**. Turn Google Analytics
   off — you don't need it. The free Spark plan is far more than enough for a task list.
2. In the project, choose **Build → Authentication → Get started → Email/Password →
   Enable → Save**.
3. Choose **Build → Firestore Database → Create database**. Pick a location near you and
   start in **production mode** (the rules below replace the defaults).
4. Go to **Project settings (gear) → General → Your apps → Web (`</>`)**. Register the
   app with any nickname. Firebase shows you a `firebaseConfig` object.

### Wire it up

Copy those values into `firebase-config.js`, replacing the `PASTE_...` placeholders, then
commit and push. GitHub Pages redeploys in about a minute.

These values are **not secrets**. Firebase web config is public by design and ships in
every client app; what protects your data is the rules below plus signing in.

### Lock it down

In the Firebase console, **Firestore Database → Rules**, replace everything with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Publish it. This says: you can only touch your own data, and only while signed in.
Without this rule your database is open to anyone who finds it — do not skip it.

### Sign in

Reload the app. You'll get a sign-in screen. Tap **Create account** once with your email
and a password, then **Sign in** with those same details on your other devices. All of
them now show one list, updating live.

---

## How it behaves

| Situation | What happens |
| --- | --- |
| No backend configured | Works fully; tasks stay on that device. Pill reads *this device*. |
| Signed in, online | One list everywhere, updating live. Pill reads *synced*. |
| Signed in, no signal | Everything still works from the local copy; writes queue and catch up. Pill reads *offline*. |
| Signed out | Sign-in screen. Your data is untouched on the server. |

Task data is held by Firestore's own IndexedDB cache, not by the service worker — the
service worker only caches the app shell so it opens instantly with no network.

---

## Updating it

Edit the files, commit, push. Pages redeploys automatically.

One catch: the service worker caches the shell, so bump `CACHE` in `sw.js` (`ledger-v1` →
`ledger-v2`) whenever you change `index.html`, `styles.css`, or `app.js`. Without that
bump, installed devices may keep serving the old files.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell and the sign-in screen |
| `styles.css` | All styling, light and dark |
| `app.js` | The whole app: parsing, priority, rendering, storage |
| `firebase-config.js` | Your project's config — the only file you edit to enable sync |
| `sw.js` | Service worker; offline shell caching |
| `manifest.webmanifest` | Name, icon, colours, standalone display |
| `icons/icon-192.png` | Home screen icon |
