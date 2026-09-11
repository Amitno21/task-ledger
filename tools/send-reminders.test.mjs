/**
 * Runs the real sender script as a separate process, the same way GitHub Actions
 * does, and checks its exit code. Exit 0 = GitHub shows a green tick, no email.
 * Exit 1 = red cross and a failure email. None of these cases touch the network:
 * the script decides before it ever loads Firebase.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./send-reminders.mjs", import.meta.url));

function runWith(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  // Don't let a test run scribble on the real Actions summary page.
  delete env.GITHUB_STEP_SUMMARY;
  for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "FIREBASE_SERVICE_ACCOUNT", "FORCE_SEND"]) {
    if (!(k in extraEnv)) delete env[k];
  }
  const r = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8", timeout: 20000 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

test("before Firebase is set up: succeeds quietly (this was the failing case)", () => {
  const r = runWith({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" });
  assert.equal(r.code, 0, `expected success, got ${r.code}:\n${r.out}`);
  assert.match(r.out, /::notice::Firebase isn't set up yet/);
});

test("notification keys deleted: fails so you find out", () => {
  const r = runWith({});
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /::error::.*VAPID/);
});

test("Firebase key pasted wrongly: fails with a plain explanation", () => {
  const r = runWith({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", FIREBASE_SERVICE_ACCOUNT: "{ broken" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /::error::.*valid JSON/);
});
