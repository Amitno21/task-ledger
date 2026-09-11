import { test } from "node:test";
import assert from "node:assert/strict";
import { checkConfig, localNow, greeting, digest, isDue } from "./digest.mjs";

const VAPID = { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" };
const GOOD_ACCOUNT = JSON.stringify({ project_id: "p", client_email: "e@p.iam", private_key: "k" });

/* ---------- checkConfig: the bug that caused the failure emails ---------- */

test("missing Firebase key means 'not set up yet', not a failure", () => {
  assert.equal(checkConfig({ ...VAPID }).state, "not-configured");
});

test("a blank Firebase key is treated the same as missing", () => {
  assert.equal(checkConfig({ ...VAPID, FIREBASE_SERVICE_ACCOUNT: "   \n " }).state, "not-configured");
});

test("missing notification keys is a real problem even before Firebase", () => {
  assert.equal(checkConfig({}).state, "invalid");
  assert.equal(checkConfig({ VAPID_PUBLIC_KEY: "pub" }).state, "invalid");
  assert.match(checkConfig({}).message, /VAPID/);
});

test("a Firebase key that isn't JSON fails loudly", () => {
  const r = checkConfig({ ...VAPID, FIREBASE_SERVICE_ACCOUNT: "not json {" });
  assert.equal(r.state, "invalid");
  assert.match(r.message, /valid JSON/);
});

test("a Firebase key missing required fields fails and names them", () => {
  const r = checkConfig({ ...VAPID, FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: "p" }) });
  assert.equal(r.state, "invalid");
  assert.match(r.message, /client_email/);
  assert.match(r.message, /private_key/);
});

test("a complete configuration is ready and hands back the parsed key", () => {
  const r = checkConfig({ ...VAPID, FIREBASE_SERVICE_ACCOUNT: GOOD_ACCOUNT });
  assert.equal(r.state, "ready");
  assert.equal(r.serviceAccount.project_id, "p");
});

/* ---------- localNow: reading the person's own clock ---------- */

test("UTC is read directly", () => {
  assert.deepEqual(localNow("UTC", new Date("2026-09-11T08:15:00Z")), { hour: 8, date: "2026-09-11" });
});

test("Israel in summer time (UTC+3)", () => {
  assert.deepEqual(localNow("Asia/Jerusalem", new Date("2026-09-11T05:30:00Z")), { hour: 8, date: "2026-09-11" });
});

test("Israel in winter time (UTC+2) — same 08:00, different UTC hour", () => {
  assert.deepEqual(localNow("Asia/Jerusalem", new Date("2026-01-15T06:30:00Z")), { hour: 8, date: "2026-01-15" });
});

test("the local date can be a day behind UTC", () => {
  assert.deepEqual(localNow("America/Los_Angeles", new Date("2026-09-11T03:00:00Z")), { hour: 20, date: "2026-09-10" });
});

test("midnight reads as hour 0, not 24", () => {
  assert.equal(localNow("UTC", new Date("2026-09-11T00:05:00Z")).hour, 0);
});

test("an unknown timezone falls back to UTC instead of crashing", () => {
  assert.deepEqual(localNow("Not/AZone", new Date("2026-09-11T08:15:00Z")), { hour: 8, date: "2026-09-11" });
});

test("an empty timezone falls back to UTC", () => {
  assert.equal(localNow("", new Date("2026-09-11T08:15:00Z")).hour, 8);
  assert.equal(localNow(undefined, new Date("2026-09-11T08:15:00Z")).hour, 8);
});

/* ---------- greeting ---------- */

test("greeting switches at noon and 5pm", () => {
  assert.equal(greeting(0), "Good morning");
  assert.equal(greeting(11), "Good morning");
  assert.equal(greeting(12), "Good afternoon");
  assert.equal(greeting(16), "Good afternoon");
  assert.equal(greeting(17), "Good evening");
});

/* ---------- digest: what the notification says ---------- */

const TODAY = "2026-09-11";

test("stays silent when nothing is due and nothing is overdue", () => {
  assert.equal(digest([{ title: "later", due: "2026-09-20" }, { title: "no date" }], TODAY), null);
  assert.equal(digest([], TODAY), null);
});

test("finished tasks never count", () => {
  assert.equal(digest([{ due: TODAY, done: true }, { due: "2026-01-01", done: true }], TODAY), null);
});

test("one task due today", () => {
  assert.equal(digest([{ due: TODAY }], TODAY), "1 thing needs you today.");
});

test("several tasks due today", () => {
  assert.equal(digest([{ due: TODAY }, { due: TODAY }], TODAY), "2 things need you today.");
});

test("one overdue task", () => {
  assert.equal(digest([{ due: "2026-09-01" }], TODAY), "1 has slipped past the date you set.");
});

test("due today and overdue together", () => {
  const tasks = [{ due: TODAY }, { due: TODAY }, { due: "2026-09-01" }, { due: "2026-08-30" }, { due: "2026-09-10" }];
  assert.equal(digest(tasks, TODAY), "2 things need you today, 3 have slipped past the date you set.");
});

test("damaged data doesn't crash it", () => {
  assert.equal(digest(null, TODAY), null);
  assert.equal(digest("nonsense", TODAY), null);
  assert.equal(digest([null, undefined, 42, { due: 20260911 }], TODAY), null);
});

/* ---------- isDue: who gets a push on this run ---------- */

const SUB = { enabled: true, hour: 8, timezone: "Asia/Jerusalem", subscription: { endpoint: "https://push.example/abc" } };
const AT_8_IN_ISRAEL = new Date("2026-09-11T05:10:00Z");

test("due when it's their chosen hour in their timezone", () => {
  assert.equal(isDue(SUB, AT_8_IN_ISRAEL), true);
});

test("not due an hour later", () => {
  assert.equal(isDue(SUB, new Date("2026-09-11T06:10:00Z")), false);
});

test("never due when switched off or without a subscription", () => {
  assert.equal(isDue({ ...SUB, enabled: false }, AT_8_IN_ISRAEL), false);
  assert.equal(isDue({ ...SUB, subscription: null }, AT_8_IN_ISRAEL), false);
  assert.equal(isDue({ ...SUB, subscription: {} }, AT_8_IN_ISRAEL), false);
  assert.equal(isDue(null, AT_8_IN_ISRAEL), false);
});

test("a manual test run sends regardless of the hour", () => {
  assert.equal(isDue(SUB, new Date("2026-09-11T15:00:00Z"), true), true);
});

test("a nonsense hour falls back to 08:00", () => {
  assert.equal(isDue({ ...SUB, hour: 99 }, AT_8_IN_ISRAEL), true);
  assert.equal(isDue({ ...SUB, hour: "8" }, AT_8_IN_ISRAEL), true);
  assert.equal(isDue({ ...SUB, hour: 8.5 }, AT_8_IN_ISRAEL), true);
});
