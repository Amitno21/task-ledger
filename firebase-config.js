/* Your Firebase project's web config.
 *
 * Replace the placeholders below with the values from:
 *   Firebase console -> Project settings -> General -> Your apps -> Web app -> SDK setup
 *
 * These values are NOT secrets. Firebase web config is designed to be public and
 * ships in every client; what actually protects your data is the Firestore
 * security rules (see README.md) plus signing in. Do not put any private key here.
 *
 * Until this is filled in, the app runs happily in local-only mode: everything
 * works, but each device keeps its own list.
 */
window.LEDGER_FIREBASE_CONFIG = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "PASTE_YOUR_PROJECT.firebaseapp.com",
  projectId: "PASTE_YOUR_PROJECT_ID",
  storageBucket: "PASTE_YOUR_PROJECT.appspot.com",
  messagingSenderId: "PASTE_YOUR_SENDER_ID",
  appId: "PASTE_YOUR_APP_ID"
};
