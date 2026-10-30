"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { io } = require("socket.io-client");
const { createApplication } = require("../server");
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

test("chat accepts player messages only, limits input and never sends to watchers or other rooms", async (t) => {
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
  const send = (socket, text) => socket.timeout(1000).emitWithAck("chatSend", { text, name: "spoofed" });
  assert.ok((await send(outsider, "outside")).error);
  const created = once(host, "roomCreated");
  host.emit("createRoom", { name: "Host" });
  const { roomId } = await created;
  const joined = once(guest, "roomJoined");
  guest.emit("joinRoom", { roomId, name: "Guest" });
  await joined;
  const watched = once(watcher, "watchJoined");
  watcher.emit("joinWatch", { roomId, key: app.rooms.get(roomId).watchKey });
  await watched;
  const otherCreated = once(outsider, "roomCreated");
  outsider.emit("createRoom", { name: "Other" });
  await otherCreated;
  const leaks = [];
  watcher.on("chatMessage", (message) => leaks.push(message));
  outsider.on("chatMessage", (message) => leaks.push(message));
  assert.ok((await send(watcher, "watcher")).error);
  assert.ok((await send(host, " ")).error);
  assert.ok((await send(host, "x".repeat(161))).error);
  const received = once(guest, "chatMessage");
  const echoed = once(host, "chatMessage");
  assert.deepEqual(await send(host, "hello\n<script>"), { ok: true });
  const expected = { roomId, name: "Host", text: "hello <script>" };
  assert.deepEqual(await received, expected);
  assert.deepEqual(await echoed, expected);
  assert.ok((await send(host, "too fast")).error);
  const left = once(host, "roomUpdated");
  guest.emit("leaveRoom");
  await left;
  assert.ok((await send(guest, "after leaving")).error);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(leaks, []);
});

test("chat displays messages as text, ignores other rooms, and preserves unsent input on error", async () => {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const elements = new Map();
  for (const id of ["chatLatest", "chatInput", "chatSend", "chatForm", "roomChat"]) {
    elements.set(id, { value: "", handlers: {}, classList: { toggle() {} }, addEventListener(event, fn) { this.handlers[event] = fn; } });
  }
  let result = { ok: true };
  const handlers = {};
  const socket = { connected: true, on(event, fn) { handlers[event] = fn; }, timeout() { return this; }, async emitWithAck() { return result; } };
  const context = { window: {}, document: { getElementById: (id) => elements.get(id) } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/room-chat.js"), "utf8"), context);
  const controller = context.window.ChopanChat.createController(socket);
  controller.setRoom("1234");
  handlers.chatMessage({ roomId: "1234", name: "A", text: "<img src=x onerror=alert(1)>" });
  assert.equal(elements.get("chatLatest").textContent, "A：<img src=x onerror=alert(1)>");
  handlers.chatMessage({ roomId: "9999", name: "B", text: "other" });
  assert.match(elements.get("chatLatest").textContent, /^A：/);
  elements.get("chatInput").value = "test";
  result = { error: "retry" };
  await elements.get("chatForm").handlers.submit({ preventDefault() {} });
  assert.equal(elements.get("chatInput").value, "test");
  assert.equal(elements.get("chatLatest").textContent, "retry");
  result = { ok: true };
  await elements.get("chatForm").handlers.submit({ preventDefault() {} });
  assert.equal(elements.get("chatInput").value, "");
  controller.setRoom(null);
  assert.equal(elements.get("chatInput").disabled, true);
});
