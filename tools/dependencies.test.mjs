/**
 * Guards against the libraries changing shape underneath the sender.
 *
 * firebase-admin 14 removed the `admin.firestore()` style this script used to
 * rely on, which would only have surfaced as a crash the first morning after
 * Firebase was set up. These checks load the real installed libraries and
 * confirm every function the sender calls is actually there. Nothing here talks
 * to the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("firebase-admin/app provides initializeApp and cert", async () => {
  const app = await import("firebase-admin/app");
  assert.equal(typeof app.initializeApp, "function");
  assert.equal(typeof app.cert, "function");
});

test("firebase-admin/firestore provides getFirestore", async () => {
  const fs = await import("firebase-admin/firestore");
  assert.equal(typeof fs.getFirestore, "function");
});

test("web-push provides setVapidDetails and sendNotification", async () => {
  const { default: webpush } = await import("web-push");
  assert.equal(typeof webpush.setVapidDetails, "function");
  assert.equal(typeof webpush.sendNotification, "function");
});

test("web-push accepts a correctly shaped VAPID key pair", async () => {
  const { default: webpush } = await import("web-push");
  // A throwaway pair generated on the spot, so this proves the library works
  // without ever touching the real keys.
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  assert.doesNotThrow(() => webpush.setVapidDetails("mailto:test@example.com", publicKey, privateKey));
});

test("the sender is running on a supported Node.js", () => {
  const major = Number(process.versions.node.split(".")[0]);
  assert.ok(major >= 24, `Node ${process.versions.node} is below the required 24`);
});
