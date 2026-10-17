"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { io: createClient } = require("socket.io-client");
const {
  CARD_DISPLAY_TIMINGS,
  CARD_LAYOUT,
  ORDER_GAME_TIMINGS,
  createApplication: createServerApplication,
  createCardLayout,
  createDeck
} = require("../server");

function createApplication(options = {}) {
  return createServerApplication({ skipOrderGame: true, ...options });
}

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

test("card display timings are centralized at the requested durations", () => {
  assert.equal(CARD_DISPLAY_TIMINGS.mismatchMs, 2200);
  assert.equal(CARD_DISPLAY_TIMINGS.jokerRevealMs, 8000);
  assert.equal(Object.isFrozen(CARD_DISPLAY_TIMINGS), true);
});

test("order game timings allow ten seconds to choose and a short result reveal", () => {
  assert.equal(ORDER_GAME_TIMINGS.choiceMs, 10_000);
  assert.equal(ORDER_GAME_TIMINGS.revealMs, 3500);
  assert.equal(Object.isFrozen(ORDER_GAME_TIMINGS), true);
});

test("players privately choose cards and the revealed values determine turn order", async (t) => {
  const game = createServerApplication({ random: () => 0.42, orderChoiceMs: 100, orderRevealMs: 10 });
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());
  const host = await connect(url);
  const guest = await connect(url);
  t.after(() => { host.close(); guest.close(); });

  const createdPromise = once(host, "roomCreated");
  host.emit("createRoom", { name: "ホスト" });
  const { roomId } = await createdPromise;
  const joinedPromise = once(host, "roomUpdated");
  guest.emit("joinRoom", { name: "ゲスト", roomId });
  await joinedPromise;

  const selectionPromise = once(host, "orderSelectionStarted");
  host.emit("startGame");
  const selection = await selectionPromise;
  assert.equal(selection.status, "orderSelection");
  assert.equal(selection.orderCards.length, 2);
  assert.equal(selection.orderCards.every((card) => card.value === undefined), true, "values stay secret while choosing");

  const hostChoicePromise = once(host, "orderCardChosen");
  host.emit("chooseOrderCard", { cardId: selection.orderCards[0].id });
  const hostChoice = await hostChoicePromise;
  assert.equal(hostChoice.orderCards[0].chosenBy, host.id);

  const revealPromise = once(host, "orderRevealed");
  guest.emit("chooseOrderCard", { cardId: selection.orderCards[1].id });
  const revealed = await revealPromise;
  assert.equal(revealed.status, "orderResult");
  assert.equal(revealed.orderCards.every((card) => card.value !== undefined), true);
  assert.equal(new Set(revealed.turnOrder).size, 2);
  assert.deepEqual(revealed.turnOrder, [host.id, guest.id], "the joker holder goes first");

  const started = await once(host, "gameStarted");
  assert.equal(started.status, "playing");
  assert.equal(started.currentPlayerId, host.id);
});

test("the order game automatically chooses for players when time expires", async (t) => {
  const game = createServerApplication({ random: () => 0.25, orderChoiceMs: 15, orderRevealMs: 5 });
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
  const revealPromise = once(host, "orderRevealed");
  host.emit("startGame");
  const revealed = await revealPromise;

  assert.equal(revealed.orderCards.every((card) => card.chosenBy), true);
  assert.equal(new Set(revealed.orderCards.map((card) => card.chosenBy)).size, 2);
  assert.equal(revealed.turnOrder.length, 2);
  assert.equal((await once(host, "gameStarted")).status, "playing");
});

test("server-generated card layout stays within bounds and avoids excessive overlap", () => {
  let seed = 123456;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const layout = createCardLayout(34, random);

  assert.equal(layout.length, 34);
  layout.forEach((card) => {
    assert.ok(Math.abs(card.xOffset) <= CARD_LAYOUT.X_OFFSET_MAX);
    assert.ok(Math.abs(card.yOffset) <= CARD_LAYOUT.Y_OFFSET_MAX);
    assert.ok(Math.abs(card.rotation) <= CARD_LAYOUT.MAX_ROTATION);
    assert.ok(card.zIndex >= 1 && card.zIndex <= 20);
  });

  for (let first = 0; first < layout.length; first += 1) {
    for (let second = 0; second < first; second += 1) {
      for (const columns of CARD_LAYOUT.VALIDATED_COLUMNS) {
        const dx = ((first % columns) - (second % columns))
          * (CARD_LAYOUT.REFERENCE_CARD_WIDTH + CARD_LAYOUT.COLUMN_GAP)
          + layout[first].xOffset - layout[second].xOffset;
        const dy = (Math.floor(first / columns) - Math.floor(second / columns))
          * (CARD_LAYOUT.REFERENCE_CARD_HEIGHT + CARD_LAYOUT.ROW_GAP)
          + layout[first].yOffset - layout[second].yOffset;
        assert.ok(Math.hypot(dx, dy) >= CARD_LAYOUT.MIN_CENTER_DISTANCE);
      }
    }
  }
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
  const hostAccessPromise = once(host, "hostWatchAccess");
  host.emit("createRoom", { name: "ホスト" });
  const created = await createdPromise;
  const hostAccess = await hostAccessPromise;
  assert.match(created.roomId, /^\d{4}$/);
  assert.equal(created.watchKey, undefined);
  assert.equal(hostAccess.roomId, created.roomId);
  assert.match(hostAccess.watchKey, /^[A-Za-z0-9_-]{43}$/);

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
  assert.equal(started.message, "", "game start does not emit a large overlay message");
});

test("a waiting room remains joinable and watchable during a transient host disconnect", async (t) => {
  const game = createApplication({ disconnectGraceMs: 500 });
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());

  const host = await connect(url);
  const createdPromise = once(host, "roomCreated");
  host.emit("createRoom", { name: "ホスト" });
  const created = await createdPromise;
  host.close();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (game.rooms.get(created.roomId)?.players[0]?.connected === false) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(game.rooms.has(created.roomId), true, "room survives the reconnect grace period");

  const watcher = await connect(url);
  t.after(() => watcher.close());
  const watchedPromise = once(watcher, "watchJoined");
  watcher.emit("joinWatch", {
    roomId: created.roomId,
    key: game.rooms.get(created.roomId).watchKey
  });
  assert.equal((await watchedPromise).roomId, created.roomId);

  const guest = await connect(url);
  t.after(() => guest.close());
  const joinedPromise = once(guest, "roomJoined");
  guest.emit("joinRoom", { name: "ゲスト", roomId: created.roomId });
  assert.equal((await joinedPromise).players.length, 2);

  const resumedHost = await connect(url);
  t.after(() => resumedHost.close());
  const resumedPromise = once(resumedHost, "roomResumed");
  resumedHost.emit("resumeRoom", {
    roomId: created.roomId,
    resumeToken: created.resumeToken
  });
  const resumed = await resumedPromise;
  assert.equal(resumed.hostId, resumedHost.id);
  assert.equal(resumed.players.find((player) => player.name === "ホスト").connected, true);
});

test("a player can explicitly leave during a game and immediately join another room", async (t) => {
  const game = createApplication();
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());
  const host = await connect(url);
  const guest = await connect(url);
  t.after(() => { host.close(); guest.close(); });

  const createdPromise = once(host, "roomCreated");
  host.emit("createRoom", { name: "退出する人" });
  const { roomId } = await createdPromise;
  const joinedPromise = once(guest, "roomJoined");
  guest.emit("joinRoom", { name: "続ける人", roomId });
  await joinedPromise;
  const startedPromise = once(host, "gameStarted");
  host.emit("startGame");
  await startedPromise;

  const updatedPromise = once(guest, "roomUpdated");
  host.emit("leaveRoom");
  const updated = await updatedPromise;
  assert.deepEqual(updated.players.map((player) => player.name), ["続ける人"]);
  assert.equal(updated.currentPlayerId, guest.id, "the turn moves to the remaining player");
  assert.equal(updated.hostId, guest.id, "host authority moves to the remaining player");

  const nextRoomPromise = once(host, "roomCreated");
  host.emit("createRoom", { name: "退出する人" });
  const nextRoom = await nextRoomPromise;
  assert.notEqual(nextRoom.roomId, roomId);
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
  const guestActivatedPromise = once(guest, "jokerActivated");
  host.emit("flipCard", { index: jokers[1] });
  const [activated, guestActivated] = await Promise.all([activatedPromise, guestActivatedPromise]);
  assert.equal(activated.revealAll, true);
  assert.equal(guestActivated.revealAll, true, "the opponent receives the joker announcement event");
  assert.equal(activated.isProcessing, true);
  assert.ok(activated.revealEndsAt > Date.now());
  assert.equal(activated.players.find((player) => player.id === host.id).score, 2);
  assert.equal(activated.cards.filter((card) => !card.matched).every((card) => card.name), true);

  const blockedCard = room.cards.findIndex((card) => !card.matched);
  host.emit("flipCard", { index: blockedCard });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(room.selectedCards, [], "card input stays locked during the joker reveal");

  const locked = await once(host, "turnChanged");
  assert.equal(locked.revealAll, false);
  assert.equal(locked.revealEndsAt, null);
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
  watcher.emit("joinWatch", { roomId, key: game.rooms.get(roomId).watchKey });
  const watching = await watchingPromise;
  assert.equal(watching.players.length, 2);
  assert.equal(watching.watchKey, undefined);
  assert.equal(game.rooms.get(roomId).players.length, 2, "watcher is not added to players");

  const deniedPromise = once(watcher, "errorMessage");
  watcher.emit("joinRoom", { name: "侵入", roomId });
  assert.match((await deniedPromise).message, /観戦者/);
  assert.equal(game.rooms.get(roomId).players.length, 2);

  const cardsBefore = game.rooms.get(roomId).selectedCards.length;
  const flipDenied = once(watcher, "errorMessage");
  watcher.emit("flipCard", { index: 0 });
  assert.match((await flipDenied).message, /ルームに参加していません/);
  assert.equal(game.rooms.get(roomId).selectedCards.length, cardsBefore);

  const watcherStarted = once(watcher, "gameStarted");
  host.emit("startGame");
  const started = await watcherStarted;
  assert.equal(started.status, "playing");
  assert.equal(started.cards.length, 34);
  assert.equal(started.cards.every((card) => !card.name), true);
  assert.equal(started.message, "", "watchers do not receive a game start overlay message");

  const hostFlip = once(host, "cardFlipped");
  const watcherFlip = once(watcher, "cardFlipped");
  host.emit("flipCard", { index: 0 });
  const [playerFlipped, flipped] = await Promise.all([hostFlip, watcherFlip]);
  assert.deepEqual(flipped.cards, playerFlipped.cards, "player and watcher receive the exact same card state");
  assert.deepEqual(flipped.selectedCards, playerFlipped.selectedCards);
  assert.deepEqual(flipped.players, playerFlipped.players);
  assert.equal(flipped.currentPlayerId, playerFlipped.currentPlayerId);
  assert.equal(flipped.cards[0].visible, true);
  assert.ok(flipped.cards[0].name);
});

test("a disconnected player is removed after the reconnect grace period during a game", async (t) => {
  const game = createApplication({ disconnectGraceMs: 15 });
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());
  const host = await connect(url);
  const guest = await connect(url);
  t.after(() => { host.close(); guest.close(); });

  const createdPromise = once(host, "roomCreated");
  host.emit("createRoom", { name: "A" });
  const { roomId } = await createdPromise;
  const joinedPromise = once(guest, "roomJoined");
  guest.emit("joinRoom", { name: "B", roomId });
  await joinedPromise;
  const startedPromise = once(host, "gameStarted");
  host.emit("startGame");
  await startedPromise;

  guest.close();
  await new Promise((resolve) => setTimeout(resolve, 35));
  const room = game.rooms.get(roomId);
  assert.deepEqual(room.players.map((player) => player.name), ["A"]);
  assert.equal(room.currentPlayerIndex, 0);
});

test("players, late watchers, and rematches receive the authoritative room layout", async (t) => {
  let seed = 98765;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const game = createApplication({ random, failDelay: 10, jokerDelay: 15 });
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
  const joinedPromise = once(guest, "roomJoined");
  guest.emit("joinRoom", { name: "B", roomId });
  await joinedPromise;

  const hostStarted = once(host, "gameStarted");
  const guestStarted = once(guest, "gameStarted");
  host.emit("startGame");
  const [hostState, guestState] = await Promise.all([hostStarted, guestStarted]);
  const firstLayout = hostState.cards.map(({ xOffset, yOffset, rotation, zIndex }) => (
    { xOffset, yOffset, rotation, zIndex }
  ));
  assert.deepEqual(guestState.cards.map(({ xOffset, yOffset, rotation, zIndex }) => (
    { xOffset, yOffset, rotation, zIndex }
  )), firstLayout);

  const lateJoin = once(watcher, "watchJoined");
  watcher.emit("joinWatch", { roomId, key: game.rooms.get(roomId).watchKey });
  const watchState = await lateJoin;
  assert.deepEqual(watchState.cards.map(({ xOffset, yOffset, rotation, zIndex }) => (
    { xOffset, yOffset, rotation, zIndex }
  )), firstLayout);

  game.rooms.get(roomId).status = "finished";
  host.emit("requestRematch");
  const rematchStarted = once(host, "gameStarted");
  guest.emit("requestRematch");
  const rematch = await rematchStarted;
  const secondLayout = rematch.cards.map(({ xOffset, yOffset, rotation, zIndex }) => (
    { xOffset, yOffset, rotation, zIndex }
  ));
  assert.notDeepEqual(secondLayout, firstLayout);
});

test("a player can reload and resume the same server-side board", async (t) => {
  const game = createApplication({ failDelay: 10, jokerDelay: 15 });
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());
  const host = await connect(url);
  const guest = await connect(url);
  t.after(() => { host.close(); guest.close(); });

  const createdPromise = once(host, "roomCreated");
  host.emit("createRoom", { name: "A" });
  const created = await createdPromise;
  const guestJoined = once(guest, "roomJoined");
  guest.emit("joinRoom", { name: "B", roomId: created.roomId });
  const guestState = await guestJoined;
  const startedPromise = once(host, "gameStarted");
  host.emit("startGame");
  const started = await startedPromise;
  const boardLayout = started.cards.map(({ xOffset, yOffset, rotation, zIndex }) => (
    { xOffset, yOffset, rotation, zIndex }
  ));

  guest.close();
  const resumedSocket = await connect(url);
  t.after(() => resumedSocket.close());
  const resumedPromise = once(resumedSocket, "roomResumed");
  resumedSocket.emit("resumeRoom", {
    roomId: created.roomId,
    resumeToken: guestState.resumeToken
  });
  const resumed = await resumedPromise;
  assert.equal(resumed.status, "playing");
  assert.equal(resumed.players.find((player) => player.name === "B").id, resumedSocket.id);
  assert.deepEqual(resumed.cards.map(({ xOffset, yOffset, rotation, zIndex }) => (
    { xOffset, yOffset, rotation, zIndex }
  )), boardLayout);
});

test("watch and OBS routes require the server-generated watch key", async (t) => {
  const game = createApplication();
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());

  const watchResponse = await fetch(`${url}/watch/4821?key=invalid`);
  const obsResponse = await fetch(`${url}/obs/4821?key=invalid`);
  assert.equal(watchResponse.status, 200);
  assert.equal(obsResponse.status, 200);
  assert.match(await watchResponse.text(), /観戦専用画面/);

  const watcher = await connect(url);
  t.after(() => watcher.close());
  const unavailablePromise = once(watcher, "watchUnavailable");
  watcher.emit("joinWatch", { roomId: "4821" });
  assert.equal((await unavailablePromise).message, "観戦URLが無効です");
});

test("watch keys are random, private, and invalid keys reveal no game state", async (t) => {
  const game = createApplication();
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());
  const firstHost = await connect(url);
  const secondHost = await connect(url);
  const watcher = await connect(url);
  t.after(() => { firstHost.close(); secondHost.close(); watcher.close(); });

  const firstCreated = once(firstHost, "roomCreated");
  firstHost.emit("createRoom", { name: "A" });
  const firstState = await firstCreated;
  const secondCreated = once(secondHost, "roomCreated");
  secondHost.emit("createRoom", { name: "B" });
  const secondState = await secondCreated;
  const firstRoom = game.rooms.get(firstState.roomId);
  const secondRoom = game.rooms.get(secondState.roomId);

  assert.match(firstRoom.watchKey, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(firstRoom.watchKey, secondRoom.watchKey);
  assert.equal(firstState.watchKey, undefined, "the key is not included in public game state");

  const invalid = once(watcher, "watchUnavailable");
  watcher.emit("joinWatch", { roomId: firstState.roomId, key: secondRoom.watchKey });
  assert.equal((await invalid).message, "観戦URLが無効です");
  assert.equal(watcher.listeners("watchJoined").length, 0);
});

test("a failed watch-room switch unsubscribes the socket from its previous room", async (t) => {
  const game = createApplication();
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());
  const host = await connect(url);
  const watcher = await connect(url);
  t.after(() => { host.close(); watcher.close(); });

  const createdPromise = once(host, "roomCreated");
  host.emit("createRoom", { name: "A" });
  const { roomId } = await createdPromise;
  const joinedPromise = once(watcher, "watchJoined");
  watcher.emit("joinWatch", { roomId, key: game.rooms.get(roomId).watchKey });
  await joinedPromise;

  const unavailablePromise = once(watcher, "watchUnavailable");
  watcher.emit("joinWatch", { roomId, key: "invalid" });
  await unavailablePromise;
  const serverSocket = game.io.sockets.sockets.get(watcher.id);
  assert.equal(serverSocket.rooms.has(`watch:${roomId}`), false);
});

test("all four supplied chopa images are served with the expected dimensions", async (t) => {
  const game = createApplication();
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());

  for (let number = 1; number <= 4; number += 1) {
    const response = await fetch(`${url}/images/chopa/chopa_${number}.png`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^image\/png/);
    const image = Buffer.from(await response.arrayBuffer());
    assert.equal(image.subarray(1, 4).toString(), "PNG");
    assert.equal(image.readUInt32BE(16), 370);
    assert.equal(image.readUInt32BE(20), 320);
    assert.equal(image[25], 6, "the supplied PNG keeps its transparent background");
  }
});

test("the supplied hagechopa artwork is served as a transparent joker image", async (t) => {
  const game = createApplication();
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());

  const response = await fetch(`${url}/images/hagechopa/hagechopa_joker.png`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^image\/png/);
  const image = Buffer.from(await response.arrayBuffer());
  assert.equal(image.subarray(1, 4).toString(), "PNG");
  assert.ok(image.readUInt32BE(16) >= 1000);
  assert.ok(image.readUInt32BE(20) >= 1000);
  assert.equal(image[25], 6, "the supplied PNG keeps its transparent background");
});

test("all generated chinchilla character variants are served as transparent PNGs", async (t) => {
  const game = createApplication();
  const address = await game.start();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => game.close());

  for (const character of ["goma", "rei", "guri"]) {
    for (let number = 1; number <= 4; number += 1) {
      const response = await fetch(`${url}/images/${character}/${character}_${number}.png`);
      assert.equal(response.status, 200, `${character}_${number} should be served`);
      assert.match(response.headers.get("content-type"), /^image\/png/);
      const image = Buffer.from(await response.arrayBuffer());
      assert.equal(image.subarray(1, 4).toString(), "PNG");
      assert.ok(image.readUInt32BE(16) >= 1000);
      assert.ok(image.readUInt32BE(20) >= 1000);
      assert.equal(image[25], 6, `${character}_${number} should preserve transparency`);
    }
  }
});
