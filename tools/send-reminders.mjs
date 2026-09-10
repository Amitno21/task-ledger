/**
 * Daily digest sender.
 *
 * Runs hourly from GitHub Actions. For every subscriber whose chosen hour it is
 * right now in their own timezone, works out what's waiting and sends one push.
 *
 * Deliberately quiet: if nothing is due today and nothing is overdue, no push is
 * sent at all. A daily "you have nothing to do" notification is how people learn
 * to ignore an app.
 */
import admin from "firebase-admin";
import webpush from "web-push";

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, FIREBASE_SERVICE_ACCOUNT } = process.env;
const FORCE = String(process.env.FORCE_SEND || "").toLowerCase() === "true";

for (const [name, val] of Object.entries({ VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, FIREBASE_SERVICE_ACCOUNT })) {
  if (!val) {
    console.error(`Missing secret: ${name}. Add it under Settings > Secrets and variables > Actions.`);
    process.exit(1);
  }
}

webpush.setVapidDetails("mailto:noreply@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

/** Current wall-clock hour (0-23) and YYYY-MM-DD date in a given timezone. */
function localNow(timeZone) {
  const tz = timeZone || "UTC";
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit"
    }).formatToParts(new Date());
  } catch {
    return localNow("UTC");          // unknown zone: fall back rather than skip
  }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { hour: Number(get("hour")), date: `${get("year")}-${get("month")}-${get("day")}` };
}

function greeting(hour) {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Mirrors the wording the app itself uses, so the two never contradict. */
function digest(tasks, today) {
  const open = tasks.filter((t) => !t.done);
  const overdue = open.filter((t) => t.due && t.due < today).length;
  const dueToday = open.filter((t) => t.due === today).length;
  if (!overdue && !dueToday) return null;         // nothing worth interrupting for

  const bits = [];
  if (dueToday) bits.push(plural(dueToday, "thing needs", "things need") + " you today");
  if (overdue) bits.push(plural(overdue, "has", "have") + " slipped past the date you set");
  return bits.join(", ") + ".";
}

async function run() {
  // Every user's push doc lives at users/{uid}/meta/push. The settings doc in the
  // same collection has no `enabled` field, so it never matches.
  const subs = await db.collectionGroup("meta").where("enabled", "==", true).get();
  console.log(`${subs.size} subscriber(s) enabled`);

  let sent = 0, skipped = 0, pruned = 0;

  for (const doc of subs.docs) {
    const data = doc.data();
    const uid = doc.ref.parent.parent?.id;
    if (!uid || !data.subscription?.endpoint) { skipped++; continue; }

    const { hour, date } = localNow(data.timezone);
    const want = typeof data.hour === "number" ? data.hour : 8;
    if (!FORCE && hour !== want) { skipped++; continue; }

    const snap = await db.collection(`users/${uid}/tasks`).get();
    const body = digest(snap.docs.map((d) => d.data()), date);
    if (!body) {
      console.log(`${uid}: nothing due, staying quiet`);
      skipped++;
      continue;
    }

    const payload = JSON.stringify({
      title: `${greeting(hour)}, your day`,
      body,
      tag: "daily-digest",
      url: "./index.html"
    });

    try {
      await webpush.sendNotification(data.subscription, payload, { TTL: 6 * 3600 });
      sent++;
      console.log(`${uid}: sent — ${body}`);
    } catch (err) {
      const code = err?.statusCode;
      // 404/410 mean the browser threw the subscription away (app deleted,
      // notifications revoked). Clear it so we stop trying forever.
      if (code === 404 || code === 410) {
        await doc.ref.set({ enabled: false, subscription: null }, { merge: true });
        pruned++;
        console.log(`${uid}: subscription gone (${code}), disabled`);
      } else {
        console.error(`${uid}: send failed (${code ?? "no status"}) ${err?.message ?? ""}`);
      }
    }
  }

  console.log(`done — sent ${sent}, skipped ${skipped}, pruned ${pruned}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
