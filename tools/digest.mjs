/**
 * The reminder's decision-making, kept free of network and database code so it
 * can be tested on its own. send-reminders.mjs does the talking to Firebase and
 * the push service; everything that decides *what* to say lives here.
 */

/**
 * Is the sender configured, and if not, is that "not set up yet" (normal while
 * Firebase is pending) or "set up wrongly" (a real problem worth an alert)?
 *
 *   ready           -> go ahead and send
 *   not-configured  -> Firebase isn't set up yet; finish quietly, no failure
 *   invalid         -> something is present but broken; fail loudly
 */
export function checkConfig(env) {
  const vapidPublic = (env.VAPID_PUBLIC_KEY || "").trim();
  const vapidPrivate = (env.VAPID_PRIVATE_KEY || "").trim();
  const account = (env.FIREBASE_SERVICE_ACCOUNT || "").trim();

  // The notification keys are created once, up front. If they're gone, that's
  // never "not set up yet" — someone deleted them.
  if (!vapidPublic || !vapidPrivate) {
    return {
      state: "invalid",
      message: "The notification keys (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) are missing from the repository secrets."
    };
  }

  // No Firebase key at all: the expected state until Firebase is set up.
  if (!account) {
    return {
      state: "not-configured",
      message: "Firebase isn't set up yet, so there is nobody to remind. Add the FIREBASE_SERVICE_ACCOUNT secret to start sending."
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(account);
  } catch {
    return {
      state: "invalid",
      message: "FIREBASE_SERVICE_ACCOUNT is set but isn't valid JSON. Paste the whole downloaded key file, unchanged."
    };
  }

  const missing = ["project_id", "client_email", "private_key"].filter((k) => !parsed || !parsed[k]);
  if (missing.length) {
    return {
      state: "invalid",
      message: `FIREBASE_SERVICE_ACCOUNT is missing ${missing.join(", ")}. It should be the key file from Firebase > Project settings > Service accounts.`
    };
  }

  return { state: "ready", message: "Configured.", serviceAccount: parsed };
}

/**
 * The current hour (0-23) and date (YYYY-MM-DD) as a person in `timeZone` would
 * read them off their own clock. An unknown or empty zone falls back to UTC
 * rather than dropping the person entirely.
 */
export function localNow(timeZone, now = new Date()) {
  const tz = timeZone || "UTC";
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit"
    }).formatToParts(now);
  } catch {
    if (tz === "UTC") throw new Error("This Node.js build cannot format dates in UTC.");
    return localNow("UTC", now);
  }
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { hour: Number(get("hour")), date: `${get("year")}-${get("month")}-${get("day")}` };
}

export function greeting(hour) {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * What the push should say, or null when there is nothing worth interrupting
 * someone for. `today` is the person's local date. Uses the same wording as the
 * app itself so the two never contradict each other.
 */
export function digest(tasks, today) {
  const open = (Array.isArray(tasks) ? tasks : []).filter((t) => t && !t.done);
  const overdue = open.filter((t) => typeof t.due === "string" && t.due && t.due < today).length;
  const dueToday = open.filter((t) => t.due === today).length;
  if (!overdue && !dueToday) return null;

  const bits = [];
  if (dueToday) bits.push(plural(dueToday, "thing needs", "things need") + " you today");
  if (overdue) bits.push(plural(overdue, "has", "have") + " slipped past the date you set");
  return bits.join(", ") + ".";
}

/** Should this subscriber get a push on this run? */
export function isDue(sub, now = new Date(), force = false) {
  if (!sub || !sub.enabled || !sub.subscription || !sub.subscription.endpoint) return false;
  if (force) return true;
  const want = Number.isInteger(sub.hour) && sub.hour >= 0 && sub.hour <= 23 ? sub.hour : 8;
  return localNow(sub.timezone, now).hour === want;
}
