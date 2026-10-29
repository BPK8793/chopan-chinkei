"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createVoiceIceProvider } = require("../voice-ice");

const env = { CLOUDFLARE_TURN_KEY_ID: "test-key", CLOUDFLARE_TURN_API_TOKEN: "server-only-secret" };
const iceServers = [{ urls: ["stun:stun.cloudflare.com:3478"] }, {
  urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
  username: "temporary-user", credential: "temporary-password"
}];

test("Cloudflare credentials are fetched server-side, sanitized and cached per player until expiry", async () => {
  let now = 100000;
  const requests = [];
  const provider = createVoiceIceProvider({ env, now: () => now, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ iceServers, secret: "must-not-forward" }) };
  } });
  const player = {};
  const result = await provider(player);
  assert.equal(requests[0].url, "https://rtc.live.cloudflare.com/v1/turn/keys/test-key/credentials/generate-ice-servers");
  assert.equal(requests[0].options.headers.Authorization, "Bearer server-only-secret");
  assert.equal(JSON.parse(requests[0].options.body).ttl, 86400);
  assert.deepEqual(result.iceServers, iceServers);
  assert.equal(result.iceTransportPolicy, "all");
  assert.equal(result.expiresAt, now + 86400000);
  assert.ok(!JSON.stringify(result).includes("server-only-secret"));
  assert.ok(!JSON.stringify(result).includes("must-not-forward"));
  assert.equal(await provider(player), result);
  assert.equal(requests.length, 1);
  await provider({});
  assert.equal(requests.length, 2, "different players receive different credential requests");
  now = result.expiresAt - 30000;
  await provider(player);
  assert.equal(requests.length, 3, "nearly expired credentials are replaced");
});

test("Cloudflare errors do not leak secrets or silently fall back, and retries are throttled", async () => {
  let requests = 0;
  const provider = createVoiceIceProvider({ env, fetchImpl: async () => {
    requests++;
    throw new Error("server-only-secret");
  } });
  const player = {};
  await assert.rejects(provider(player), (error) => /音声中継/.test(error.message) && !error.message.includes("server-only-secret"));
  await assert.rejects(provider(player), /少し待って/);
  assert.equal(requests, 1);
});

test("invalid Cloudflare responses and incomplete configuration are rejected", async () => {
  for (const response of [{ ok: false }, { ok: true, json: async () => ({}) }, { ok: true, json: async () => ({ iceServers: [{ urls: ["turn:turn.cloudflare.com"] }] }) }]) {
    await assert.rejects(createVoiceIceProvider({ env, fetchImpl: async () => response })({}), /音声中継/);
  }
  await assert.rejects(createVoiceIceProvider({ env: { CLOUDFLARE_TURN_KEY_ID: "missing-token" } })({}), /設定が不足/);
});

test("relay-only testing is supported and unconfigured local use makes no external request", async () => {
  const relay = await createVoiceIceProvider({ env: { ...env, VOICE_RELAY_ONLY: "true" }, fetchImpl: async () => ({ ok: true, json: async () => ({ iceServers }) }) })({});
  assert.equal(relay.iceTransportPolicy, "relay");
  const local = createVoiceIceProvider({ env: {}, fetchImpl: () => { throw new Error("unexpected network request"); } });
  assert.deepEqual(await local({}), { iceServers: [], iceTransportPolicy: "all" });
  await assert.rejects(createVoiceIceProvider({ env: { VOICE_RELAY_ONLY: "true" } })({}), /キーを設定/);
  await assert.rejects(createVoiceIceProvider({ env: { VOICE_ICE_SERVERS: "invalid" } })({}), /設定を確認/);
});
