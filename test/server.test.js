"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { io: createClient } = require("socket.io-client");
const { createApplication, createDeck } = require("../server");

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = createClient(url, { transports: ["websocket"], forceNew: true });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

test("deck has 16 normal pairs and one joker pair", () => {
  const deck = createDeck(() => 0.5);
  assert.equal(deck.length, 34);
  const counts = new Map();
  deck.forEach((card) => counts.set(card.pairKey, (counts.get(card.pairKey) || 0) + 1));
  assert.equal(counts.size, 17);
  counts.forEach((count) => assert.equal(count, 2));
  assert.equal(deck.filter((card) => card.joker).length, 2);
});

test("room creation, joining and host-only game start are synchronized", async (t) => {
  const game = createApplication({ random: () => 0.42, failDelay: 15, jokerDelay: 20 });
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());
  const host = await connect(url);
  const guest = await connect(url);
  t.after(() => { host.close(); guest.close(); });

  const createdPromise = once(host, "roomCreated");
  host.emit("createRoom", { name: "ホスト" });
  const created = await createdPromise;
  assert.match(created.roomId, /^\d{4}$/);

  const joinedPromise = once(guest, "roomUpdated");
  guest.emit("joinRoom", { name: "ゲスト", roomId: created.roomId });
  const joined = await joinedPromise;
  assert.equal(joined.players.length, 2);

  const errorPromise = once(guest, "errorMessage");
  guest.emit("startGame");
  assert.match((await errorPromise).message, /作成者/);

  const startedPromise = once(host, "gameStarted");
  host.emit("startGame");
  const started = await startedPromise;
  assert.equal(started.status, "playing");
  assert.equal(started.cards.length, 34);
  assert.equal(started.cards.every((card) => !card.name), true, "hidden cards do not leak their identity");
  assert.equal(started.currentPlayerId, host.id);
});

test("server rejects an out-of-turn flip and resolves a normal pair", async (t) => {
  const game = createApplication({ random: () => 0.23, failDelay: 10, jokerDelay: 15 });
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());
  const host = await connect(url);
  const guest = await connect(url);
  t.after(() => { host.close(); guest.close(); });

  const createdPromise = once(host, "roomCreated");
  host.emit("createRoom", { name: "A" });
  const { roomId } = await createdPromise;
  const joinedPromise = once(host, "roomUpdated");
  guest.emit("joinRoom", { name: "B", roomId });
  await joinedPromise;
  const startedPromise = once(host, "gameStarted");
  host.emit("startGame");
  await startedPromise;

  const outOfTurn = once(guest, "errorMessage");
  guest.emit("flipCard", { index: 0 });
  assert.match((await outOfTurn).message, /ターン/);

  const room = game.rooms.get(roomId);
  const first = 0;
  const second = room.cards.findIndex((card, index) => index !== first && card.pairKey === room.cards[first].pairKey);
  const firstFlip = once(host, "cardFlipped");
  host.emit("flipCard", { index: first });
  await firstFlip;
  const matchedPromise = once(host, "pairMatched");
  host.emit("flipCard", { index: second });
  const matched = await matchedPromise;
  assert.equal(matched.players.find((player) => player.id === host.id).score, room.cards[first].joker ? 2 : 1);
  assert.equal(matched.cards[first].matched, true);
  assert.equal(matched.currentPlayerId, host.id, "a match keeps the turn");
});

test("a mismatch hides both cards and advances the turn", async (t) => {
  const game = createApplication({ random: () => 0.31, failDelay: 15, jokerDelay: 20 });
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());
  const host = await connect(url);
  const guest = await connect(url);
  t.after(() => { host.close(); guest.close(); });

  const createdPromise = once(host, "roomCreated");
  host.emit("createRoom", { name: "A" });
  const { roomId } = await createdPromise;
  const joinedPromise = once(host, "roomUpdated");
  guest.emit("joinRoom", { name: "B", roomId });
  await joinedPromise;
  const startedPromise = once(host, "gameStarted");
  host.emit("startGame");
  await startedPromise;

  const room = game.rooms.get(roomId);
  const first = 0;
  const second = room.cards.findIndex((card) => card.pairKey !== room.cards[first].pairKey);
  const firstFlip = once(host, "cardFlipped");
  host.emit("flipCard", { index: first });
  await firstFlip;
  const failedPromise = once(host, "pairFailed");
  host.emit("flipCard", { index: second });
  const failed = await failedPromise;
  assert.equal(failed.cards[first].visible, true);
  assert.equal(failed.cards[second].visible, true);
  assert.equal(failed.isProcessing, true);

  const changed = await once(host, "turnChanged");
  assert.equal(changed.currentPlayerId, guest.id);
  assert.equal(changed.cards[first].visible, false);
  assert.equal(changed.cards[first].name, undefined);
});

test("joker pair awards two points, reveals remaining cards, then locks them again", async (t) => {
  const game = createApplication({ random: () => 0.17, failDelay: 10, jokerDelay: 20 });
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());
  const host = await connect(url);
  const guest = await connect(url);
  t.after(() => { host.close(); guest.close(); });

  const createdPromise = once(host, "roomCreated");
  host.emit("createRoom", { name: "A" });
  const { roomId } = await createdPromise;
  const joinedPromise = once(host, "roomUpdated");
  guest.emit("joinRoom", { name: "B", roomId });
  await joinedPromise;
  const startedPromise = once(host, "gameStarted");
  host.emit("startGame");
  await startedPromise;

  const room = game.rooms.get(roomId);
  const jokers = room.cards.map((card, index) => card.joker ? index : -1).filter((index) => index >= 0);
  const firstFlip = once(host, "cardFlipped");
  host.emit("flipCard", { index: jokers[0] });
  await firstFlip;
  const activatedPromise = once(host, "jokerActivated");
  host.emit("flipCard", { index: jokers[1] });
  const activated = await activatedPromise;
  assert.equal(activated.revealAll, true);
  assert.equal(activated.isProcessing, true);
  assert.equal(activated.players.find((player) => player.id === host.id).score, 2);
  assert.equal(activated.cards.filter((card) => !card.matched).every((card) => card.name), true);

  const locked = await once(host, "turnChanged");
  assert.equal(locked.revealAll, false);
  assert.equal(locked.isProcessing, false);
  assert.equal(locked.currentPlayerId, host.id);
  assert.equal(locked.cards.filter((card) => !card.matched).every((card) => !card.name), true);
});

test("watchers are read-only, are not players, and receive live card updates", async (t) => {
  const game = createApplication({ random: () => 0.27, failDelay: 10, jokerDelay: 15 });
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());
  const host = await connect(url);
  const guest = await connect(url);
  const watcher = await connect(url);
  t.after(() => { host.close(); guest.close(); watcher.close(); });

  const createdPromise = once(host, "roomCreated");
  host.emit("createRoom", { name: "A" });
  const { roomId } = await createdPromise;
  const joinedPromise = once(host, "roomUpdated");
  guest.emit("joinRoom", { name: "B", roomId });
  await joinedPromise;

  const watchingPromise = once(watcher, "watchJoined");
  watcher.emit("joinWatch", { roomId });
  const watching = await watchingPromise;
  assert.equal(watching.players.length, 2);
  assert.equal(game.rooms.get(roomId).players.length, 2, "watcher is not added to players");

  const deniedPromise = once(watcher, "errorMessage");
  watcher.emit("joinRoom", { name: "侵入", roomId });
  assert.match((await deniedPromise).message, /観戦者/);
  assert.equal(game.rooms.get(roomId).players.length, 2);

  const watcherStarted = once(watcher, "gameStarted");
  host.emit("startGame");
  const started = await watcherStarted;
  assert.equal(started.status, "playing");
  assert.equal(started.cards.length, 34);
  assert.equal(started.cards.every((card) => !card.name), true);

  const watcherFlip = once(watcher, "cardFlipped");
  host.emit("flipCard", { index: 0 });
  const flipped = await watcherFlip;
  assert.equal(flipped.cards[0].visible, true);
  assert.ok(flipped.cards[0].name);
});
