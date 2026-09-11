/**
 * Daily digest sender.
 *
 * Runs hourly from GitHub Actions. For every subscriber whose chosen hour it is
 * right now in their own timezone, works out what's waiting and sends one push.
 *
 * Three outcomes, on purpose:
 *   - Firebase not set up yet  -> finishes successfully with a note. No failure
 *                                 email, because nothing is actually wrong.
 *   - Set up, but broken       -> fails, so you hear about it.
 *   - Set up and working       -> sends, and stays silent for anyone with
 *                                 nothing due today and nothing overdue.
 */
import { appendFileSync } from "node:fs";
import { checkConfig, digest, greeting, isDue, localNow } from "./digest.mjs";

const FORCE = String(process.env.FORCE_SEND || "").toLowerCase() === "true";

/** A line in the run log, plus a visible note on the run's summary page. */
function report(kind, message) {
  const tag = kind === "error" ? "::error::" : kind === "warning" ? "::warning::" : "::notice::";
  console.log(`${tag}${message}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${message}\n`); } catch { /* summary is optional */ }
  }
}

async function run() {
  const config = checkConfig(process.env);

  if (config.state === "not-configured") {
    report("notice", config.message);
    return 0;
  }
  if (config.state === "invalid") {
    report("error", config.message);
    return 1;
  }

  // Only load the heavy libraries once we know we're going to use them.
  // firebase-admin 14 removed the old `admin.firestore()` style, so this uses
  // the per-service entry points instead.
  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { default: webpush } = await import("web-push");

  webpush.setVapidDetails("mailto:noreply@example.com",
    process.env.VAPID_PUBLIC_KEY.trim(), process.env.VAPID_PRIVATE_KEY.trim());

  try {
    initializeApp({ credential: cert(config.serviceAccount) });
  } catch (e) {
    report("error", `Firebase rejected the service account key: ${e.message}`);
    return 1;
  }
  const db = getFirestore();

  // Every user's push settings live at users/{uid}/meta/push. The settings doc
  // in the same collection has no `enabled` field, so it never matches.
  let subs;
  try {
    subs = await db.collectionGroup("meta").where("enabled", "==", true).get();
  } catch (e) {
    report("error", `Couldn't read subscribers from Firestore: ${e.message}`);
    return 1;
  }

  const now = new Date();
  let sent = 0, quiet = 0, notYet = 0, pruned = 0, failed = 0;

  for (const doc of subs.docs) {
    const sub = doc.data();
    const uid = doc.ref.parent.parent?.id;
    if (!uid || !isDue(sub, now, FORCE)) { notYet++; continue; }

    const { hour, date } = localNow(sub.timezone, now);
    let body;
    try {
      const snap = await db.collection(`users/${uid}/tasks`).get();
      body = digest(snap.docs.map((d) => d.data()), date);
    } catch (e) {
      console.error(`${uid}: couldn't read tasks — ${e.message}`);
      failed++;
      continue;
    }
    if (!body) { quiet++; continue; }

    const payload = JSON.stringify({ title: `${greeting(hour)}, your day`, body, tag: "daily-digest", url: "./index.html" });

    try {
      await webpush.sendNotification(sub.subscription, payload, { TTL: 6 * 3600 });
      sent++;
    } catch (err) {
      const code = err?.statusCode;
      // 404/410: the device threw the subscription away (app deleted or
      // notifications turned off). Clear it so we stop trying forever.
      if (code === 404 || code === 410) {
        await doc.ref.set({ enabled: false, subscription: null }, { merge: true }).catch(() => {});
        pruned++;
      } else {
        console.error(`${uid}: push failed (${code ?? "no status"}) ${err?.message ?? ""}`);
        failed++;
      }
    }
  }

  const summary = `Checked ${subs.size} subscriber(s): sent ${sent}, nothing due ${quiet}, not their hour ${notYet}, removed dead ${pruned}, failed ${failed}.`;
  report(failed ? "warning" : "notice", summary);
  // A delivery failure for one person shouldn't page you every hour; a total
  // failure (every attempt failed) should.
  return failed > 0 && sent === 0 && pruned === 0 && quiet === 0 ? 1 : 0;
}

run()
  .then((code) => process.exit(code))
  .catch((e) => { report("error", `Unexpected error: ${e?.message ?? e}`); process.exit(1); });
