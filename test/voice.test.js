"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { io } = require("socket.io-client");
const { createApplication } = require("../server");
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

test("voice signaling is limited to consenting players in the same room", async (t) => {
  const app = createApplication();
  const address = await app.start();
  const sockets = [];
  t.after(async () => { sockets.forEach((socket) => socket.close()); await app.close(); });
  async function connect() {
    const socket = io(`http://127.0.0.1:${address.port}`, { transports: ["websocket"], forceNew: true });
    sockets.push(socket);
    await once(socket, "connect");
    return socket;
  }
  const host = await connect();
  const guest = await connect();
  const watcher = await connect();
  const outsider = await connect();
  const joinVoice = (socket) => socket.timeout(1000).emitWithAck("voiceJoin", {});
  assert.ok((await joinVoice(outsider)).error);
  const created = once(host, "roomCreated");
  host.emit("createRoom", { name: "A" });
  const { roomId, resumeToken } = await created;
  const joined = once(guest, "roomJoined");
  guest.emit("joinRoom", { roomId, name: "B" });
  await joined;
  const watching = once(watcher, "watchJoined");
  watcher.emit("joinWatch", { roomId, key: app.rooms.get(roomId).watchKey });
  await watching;
  assert.ok((await joinVoice(watcher)).error);
  assert.deepEqual((await joinVoice(host)).peers, []);
  const guestPeers = (await joinVoice(guest)).peers;
  assert.equal(guestPeers[0].id, host.id);
  const signal = once(host, "voiceSignal");
  guest.emit("voiceSignal", { to: host.id, signal: { type: "offer", sdp: "test" } });
  assert.deepEqual(await signal, { from: guest.id, signal: { type: "offer", sdp: "test" } });
  const muted = once(host, "voicePeers");
  guest.emit("voiceMute", { muted: true });
  assert.equal((await muted).find((peer) => peer.id === guest.id).muted, true);
  const otherCreated = once(outsider, "roomCreated");
  outsider.emit("createRoom", { name: "C" });
  await otherCreated;
  await joinVoice(outsider);
  const leaks = [];
  watcher.on("voiceSignal", (payload) => leaks.push(payload));
  host.on("voiceSignal", (payload) => leaks.push(payload));
  outsider.emit("voiceSignal", { to: host.id, signal: { type: "offer", sdp: "wrong room" } });
  guest.emit("voiceSignal", { to: watcher.id, signal: { type: "offer", sdp: "watcher" } });
  const left = once(host, "voicePeers");
  guest.emit("voiceLeave");
  assert.equal((await left).length, 1);
  guest.emit("voiceSignal", { to: host.id, signal: { type: "offer", sdp: "after leave" } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(leaks, []);
  const replacement = await connect();
  const ended = once(host, "voiceEnded");
  const resumed = once(replacement, "roomResumed");
  replacement.emit("resumeRoom", { roomId, resumeToken });
  await Promise.all([ended, resumed]);
  const peers = (await joinVoice(guest)).peers;
  assert.deepEqual(peers, [], "a replaced connection no longer participates in voice");
  await joinVoice(replacement);
  const disconnected = new Promise((resolve) => {
    const handler = (roster) => {
      if (roster.length === 1 && roster[0].id === replacement.id) {
        replacement.off("voicePeers", handler);
        resolve(roster);
      }
    };
    replacement.on("voicePeers", handler);
  });
  guest.close();
  assert.deepEqual((await disconnected).map((peer) => peer.id), [replacement.id]);
});

function voiceHarness(getUserMedia, remotePeers = [], configuration = {}) {
  const elements = new Map();
  function element() {
    return { disabled: false, children: [], listeners: {}, classList: { toggle() {} }, setAttribute() {},
      addEventListener(event, handler) { this.listeners[event] = handler; },
      append(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; }, remove() {},
      play: async () => {} };
  }
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  const handlers = {};
  const emitted = [];
  const socket = { connected: true, id: "self", on(event, handler) { handlers[event] = handler; }, emit(...args) { emitted.push(args); },
    timeout() { return { emitWithAck: async () => ({ peers: remotePeers, iceServers: [], ...configuration }) }; } };
  const timers = [];
  const connections = [];
  class PeerConnection {
    constructor(configuration) { this.configuration = configuration; this.candidates = []; connections.push(this); }
    addTrack() {}
    async createOffer() { return { type: "offer", sdp: "local-offer" }; }
    async createAnswer() { return { type: "answer", sdp: "local-answer" }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async addIceCandidate(candidate) { this.candidates.push(candidate); }
    close() { this.closed = true; }
  }
  const window = { RTCPeerConnection: PeerConnection, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/voice-chat.js"), "utf8"), {
    window, document, RTCPeerConnection: PeerConnection, navigator: { mediaDevices: { getUserMedia } },
    setTimeout(callback, ms) { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; }
  });
  const controller = window.ChopanVoice.createController(socket);
  return { controller, elements, handlers, emitted, connections, timers };
}

test("microphone is opt-in, mute controls tracks, and leaving stops capture", async () => {
  let requests = 0;
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const ui = voiceHarness(async () => { requests++; return { getTracks: () => [track], getAudioTracks: () => [track] }; });
  ui.controller.setRoom("1234");
  assert.equal(requests, 0);
  await ui.elements.get("voiceJoin").listeners.click();
  assert.equal(requests, 1);
  ui.elements.get("voiceMute").listeners.click();
  assert.equal(track.enabled, false);
  assert.equal(ui.emitted.at(-1)[0], "voiceMute");
  assert.equal(ui.emitted.at(-1)[1].muted, true);
  ui.controller.setRoom(null);
  assert.equal(track.stopped, true);
});

test("leaving while microphone permission is pending stops the late stream", async () => {
  let resolve;
  let stopped = false;
  const ui = voiceHarness(() => new Promise((done) => { resolve = done; }));
  ui.controller.setRoom("1234");
  const joining = ui.elements.get("voiceJoin").listeners.click();
  ui.controller.setRoom(null);
  resolve({ getTracks: () => [{ stop() { stopped = true; } }] });
  await joining;
  assert.equal(stopped, true);
});

test("voice connects existing peers, queues early ICE, answers offers, and closes peers", async () => {
  const track = { enabled: true, stop() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const caller = voiceHarness(async () => stream, [{ id: "remote" }]);
  caller.controller.setRoom("1234");
  await caller.elements.get("voiceJoin").listeners.click();
  const offer = caller.emitted.find(([event]) => event === "voiceSignal")[1];
  assert.equal(offer.to, "remote");
  assert.equal(offer.signal.type, "offer");
  const receiver = voiceHarness(async () => stream);
  receiver.controller.setRoom("1234");
  await receiver.elements.get("voiceJoin").listeners.click();
  receiver.handlers.voiceSignal({ from: "caller", signal: { type: "candidate", candidate: { candidate: "ice" } } });
  receiver.handlers.voiceSignal({ from: "caller", signal: offer.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receiver.connections[0].candidates.length, 1);
  const answer = receiver.emitted.find(([event]) => event === "voiceSignal")[1];
  assert.equal(answer.signal.type, "answer");
  caller.handlers.voiceSignal({ from: "remote", signal: answer.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(caller.connections[0].remoteDescription.type, "answer");
  caller.handlers.voicePeers([]);
  assert.equal(caller.connections[0].closed, true);
  receiver.handlers.disconnect();
  assert.equal(receiver.connections[0].closed, true);
});

test("Cloudflare ICE configuration reaches WebRTC and expiry stops the microphone", async () => {
  let stopped = false;
  const track = { enabled: true, stop() { stopped = true; } };
  const ui = voiceHarness(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }), [{ id: "remote" }], {
    iceServers: [{ urls: "turn:turn.cloudflare.com", username: "temporary", credential: "temporary" }],
    iceTransportPolicy: "relay", expiresAt: Date.now() + 3600000
  });
  ui.controller.setRoom("1234");
  await ui.elements.get("voiceJoin").listeners.click();
  assert.equal(ui.connections[0].configuration.iceTransportPolicy, "relay");
  assert.equal(ui.connections[0].configuration.iceServers[0].username, "temporary");
  assert.equal(ui.timers.length, 1);
  assert.ok(ui.timers[0].ms > 3500000);
  ui.timers[0].callback();
  assert.equal(stopped, true);
  assert.equal(ui.connections[0].closed, true);
  assert.match(ui.elements.get("voiceStatus").textContent, /有効期限/);
});

test("Cloudflare credential requests require membership and cannot join after cancellation", async (t) => {
  let finishFetch;
  let startedFetch;
  const fetching = new Promise((resolve) => { startedFetch = resolve; });
  let requests = 0;
  const app = createApplication({ voiceIceOptions: {
    env: { CLOUDFLARE_TURN_KEY_ID: "key", CLOUDFLARE_TURN_API_TOKEN: "private-token" },
    fetchImpl: () => { requests++; startedFetch(); return new Promise((resolve) => { finishFetch = resolve; }); }
  } });
  const address = await app.start();
  const socket = io(`http://127.0.0.1:${address.port}`, { transports: ["websocket"], forceNew: true });
  t.after(async () => { socket.close(); await app.close(); });
  await once(socket, "connect");
  assert.ok((await socket.timeout(1000).emitWithAck("voiceJoin", {})).error);
  assert.equal(requests, 0);
  const created = once(socket, "roomCreated");
  socket.emit("createRoom", { name: "A" });
  await created;
  const joining = socket.timeout(1000).emitWithAck("voiceJoin", {});
  await fetching;
  const leftRoom = once(socket, "roomCreated");
  socket.emit("leaveRoom");
  socket.emit("createRoom", { name: "B" });
  await leftRoom;
  finishFetch({ ok: true, json: async () => ({ iceServers: [{ urls: "turn:turn.cloudflare.com", username: "temporary", credential: "temporary" }] }) });
  assert.match((await joining).error, /キャンセル/);
  assert.equal(app.io.sockets.sockets.get(socket.id).data.voiceRoom, null);
});

test("a TURN service error is displayed and releases the microphone", async () => {
  let stopped = false;
  const track = { enabled: true, stop() { stopped = true; } };
  const ui = voiceHarness(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }), [], { error: "音声中継に接続できませんでした" });
  ui.controller.setRoom("1234");
  await ui.elements.get("voiceJoin").listeners.click();
  assert.equal(stopped, true);
  assert.equal(ui.connections.length, 0);
  assert.match(ui.elements.get("voiceStatus").textContent, /音声中継/);
  assert.equal(ui.elements.get("voiceJoin").disabled, false);
});
