"use strict";

// Long-lived Cloudflare credentials stay in this server-only module.
function createVoiceIceProvider({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const apiToken = env.CLOUDFLARE_TURN_API_TOKEN?.trim();
  const ttl = 24 * 60 * 60;
  const cache = new WeakMap();
  const lastAttempts = new WeakMap();

  return async function getVoiceIce(player) {
    if (!keyId && !apiToken) {
      if (env.VOICE_RELAY_ONLY === "true") throw new Error("音声中継の検証にはCloudflareのキーを設定してください");
      let iceServers;
      try { iceServers = JSON.parse(env.VOICE_ICE_SERVERS || "[]"); } catch { throw new Error("音声接続のサーバー設定を確認してください"); }
      if (!Array.isArray(iceServers)) throw new Error("音声接続のサーバー設定を確認してください");
      return { iceServers, iceTransportPolicy: "all" };
    }
    if (!keyId || !apiToken) throw new Error("Cloudflare音声中継のサーバー設定が不足しています");
    const cached = cache.get(player);
    if (cached && cached.expiresAt - now() > 60_000) return cached;
    if (lastAttempts.has(player) && now() - lastAttempts.get(player) < 5000) {
      throw new Error("少し待ってから通話に再参加してください");
    }
    lastAttempts.set(player, now());
    const issuedAt = now();
    try {
      const response = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(3000)
      });
      if (!response.ok) throw new Error("TURN request failed");
      const data = await response.json();
      if (!Array.isArray(data.iceServers) || !data.iceServers.length) throw new Error("Missing ICE servers");
      // Only return fields needed by WebRTC; never forward an API response wholesale.
      const iceServers = data.iceServers.map((server) => {
        const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
        if (!Array.isArray(urls) || !urls.length || urls.some((url) => typeof url !== "string" || !/^(stun|stuns|turn|turns):/.test(url))) {
          throw new Error("Invalid ICE server");
        }
        const result = { urls };
        if (urls.some((url) => /^turns?:/.test(url))) {
          if (typeof server.username !== "string" || !server.username || typeof server.credential !== "string" || !server.credential) {
            throw new Error("Missing TURN credentials");
          }
          result.username = server.username;
          result.credential = server.credential;
        }
        return result;
      });
      if (!iceServers.some((server) => server.username)) throw new Error("Missing TURN service");
      const result = {
        iceServers,
        expiresAt: issuedAt + ttl * 1000,
        iceTransportPolicy: env.VOICE_RELAY_ONLY === "true" ? "relay" : "all"
      };
      cache.set(player, result);
      return result;
    } catch {
      throw new Error("音声中継に接続できませんでした。少し待って再参加してください");
    }
  };
}

module.exports = { createVoiceIceProvider };
