import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isTelegramAdmin,
  parseTelegramCommand,
  parseTelegramUpdate,
  secureEqual,
  validateTelegramInitData,
} from "../lib/telegram.ts";

const botToken = "123456:testing-token";
const nowSeconds = 1_800_000_000;

function signedInitData(overrides = {}) {
  const params = new URLSearchParams({
    auth_date: String(nowSeconds),
    query_id: "AAE-test-query",
    user: JSON.stringify({ id: 42, first_name: "Test", username: "tester" }),
    ...overrides,
  });
  const dataCheckString = Array.from(params.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

test("accepts fresh Telegram initData with a valid signature", () => {
  const result = validateTelegramInitData(signedInitData(), botToken, {
    nowMs: nowSeconds * 1_000,
    maxAgeSeconds: 3_600,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.user.id, 42);
});

test("rejects tampered and expired Telegram initData", () => {
  const tampered = new URLSearchParams(signedInitData());
  tampered.set("user", JSON.stringify({ id: 99, first_name: "Fake" }));
  assert.deepEqual(validateTelegramInitData(tampered.toString(), botToken, { nowMs: nowSeconds * 1_000 }), {
    ok: false,
    error: "invalid_signature",
  });

  assert.deepEqual(validateTelegramInitData(
    signedInitData({ auth_date: String(nowSeconds - 7_200) }),
    botToken,
    { nowMs: nowSeconds * 1_000, maxAgeSeconds: 3_600 },
  ), { ok: false, error: "expired_init_data" });
});

test("webhook secrets and admin ids fail closed", () => {
  assert.equal(secureEqual("expected-secret", "expected-secret"), true);
  assert.equal(secureEqual("wrong", "expected-secret"), false);
  assert.equal(secureEqual(undefined, "expected-secret"), false);
  assert.equal(isTelegramAdmin(42, "7, 42, 99"), true);
  assert.equal(isTelegramAdmin(41, "7, 42, 99"), false);
  assert.equal(isTelegramAdmin(42, undefined), false);
});

test("parses only structurally valid Telegram updates", () => {
  assert.deepEqual(parseTelegramUpdate({
    update_id: 10,
    message: { chat: { id: 42 }, from: { id: 42, first_name: "Test" }, text: "/start" },
  }), {
    update_id: 10,
    message: { chat: { id: 42 }, from: { id: 42, first_name: "Test" }, text: "/start" },
  });
  assert.equal(parseTelegramUpdate({ message: { from: { id: "42" } } }), null);
});

test("parses Telegram commands and strips the bot suffix", () => {
  assert.deepEqual(parseTelegramCommand(" /progress@meaning_bot 42 "), {
    command: "/progress",
    arguments: ["42"],
  });
  assert.deepEqual(parseTelegramCommand(undefined), { command: "", arguments: [] });
});

test("client sends only signed initData and waits for the Telegram SDK", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /body: JSON\.stringify\(\{ initData: app\.initData \}\)/);
  assert.match(page, /attemptCount >= 40/);
  assert.match(page, /completedStages: progress\.completedStages/);
  assert.match(page, /completedTasks: progress\.completedTasks/);
  assert.doesNotMatch(page, /\/api\/telegram\/progress[\s\S]{0,500}reflections/);
  assert.doesNotMatch(page, /initDataUnsafe|fallbackUser|sessionStorage/);
});
