"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const shouldAdd = force === undefined ? !this.contains(name) : force;
    if (shouldAdd) this.add(name);
    else this.remove(name);
    return shouldAdd;
  }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.classList = new FakeClassList();
    this.children = [];
    this.listeners = new Map();
    this.value = "";
    this.textContent = "";
    this.disabled = false;
    this.checked = false;
    this.dataset = {};
    this.style = {
      values: new Map(),
      setProperty: (name, value) => this.style.values.set(name, value)
    };
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(event, handler) { this.listeners.set(event, handler); }
  click() { this.listeners.get("click")?.({ target: this }); }
  remove() { this.removed = true; }
  setAttribute() {}
}

function runSoundManager(mode = "player") {
  const storage = new Map();
  const documentListeners = new Map();
  const played = [];
  const spoken = [];
  const synthesized = [];
  const elements = new Map();
  class FakeAudio {
    constructor(src) { this.src = src; }
    addEventListener() {}
    play() { played.push(this.src); return Promise.resolve(); }
  }
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  const speechSynthesis = {
    getVoices: () => [{ lang: "ja-JP", name: "Japanese" }],
    cancel: () => {},
    speak: (utterance) => spoken.push(utterance)
  };
  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = "running";
      this.destination = {};
    }
    createOscillator() {
      return {
        type: "",
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect: (next) => next,
        start: () => synthesized.push("start"),
        stop() {}
      };
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect: (next) => next
      };
    }
    resume() { return Promise.resolve(); }
  }
  const document = {
    addEventListener: (event, handler) => documentListeners.set(event, handler),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    }
  };
  const context = {
    Audio: FakeAudio,
    SpeechSynthesisUtterance: FakeUtterance,
    document,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    },
    window: { speechSynthesis, AudioContext: FakeAudioContext }
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "public", "sound-manager.js"), "utf8"),
    context,
    { filename: "sound-manager.js" }
  );
  const controller = context.window.ChopanAudio.createSoundController({ mode });
  return { controller, documentListeners, elements, played, spoken, storage, synthesized };
}

class FakeSocket {
  constructor(id) {
    this.id = id;
    this.handlers = new Map();
    this.emitted = [];
  }

  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, payload) { this.emitted.push([event, payload]); }
  receive(event, payload) { this.handlers.get(event)?.(payload); }
}

function createDom() {
  const elements = new Map();
  const body = new FakeElement("body");
  elements.set("body", body);
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  getElementById("homeScreen");
  getElementById("roomScreen").classList.add("hidden");
  getElementById("gameScreen").classList.add("hidden");
  getElementById("startButton").classList.add("hidden");
  return {
    elements,
    document: {
      body,
      createElement: () => new FakeElement(),
      createTextNode: (text) => ({ textContent: text }),
      getElementById
    }
  };
}

function baseState(overrides = {}) {
  return {
    roomId: "1234",
    status: "waiting",
    hostId: "host",
    players: [
      { id: "host", name: "ホスト", score: 0, connected: true, rematch: false },
      { id: "guest", name: "ゲスト", score: 0, connected: true, rematch: false }
    ],
    currentPlayerId: "host",
    cards: [],
    selectedCards: [],
    isProcessing: false,
    revealAll: false,
    revealEndsAt: null,
    remainingPairs: 17,
    message: "",
    winners: [],
    orderEndsAt: null,
    turnOrder: [],
    orderCards: [],
    ...overrides
  };
}

function runBrowserScript(filename, socketId, location = { pathname: "/", search: "" }) {
  const { document, elements } = createDom();
  const socket = new FakeSocket(socketId);
  const clipboardWrites = [];
  const timeouts = [];
  const context = {
    document,
    io: () => socket,
    localStorage: { getItem: () => "", setItem: () => {}, removeItem: () => {} },
    location,
    navigator: { clipboard: { writeText: async (value) => clipboardWrites.push(value) } },
    window: { location: { origin: "https://game.example", assign: () => {}, reload: () => {} } },
    ChopanCardView: { createCard: () => new FakeElement(), updateCard: () => {} },
    URLSearchParams,
    clearInterval: () => {},
    clearTimeout: (timer) => { if (timer) timer.cancelled = true; },
    setInterval: () => 1,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timeouts.push(timer);
      return timer;
    }
  };
  context.window.location.pathname = location.pathname;
  context.window.location.search = location.search;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "public", filename), "utf8"),
    context,
    { filename }
  );
  return { socket, elements, clipboardWrites, timeouts };
}

test("pair match messages disappear automatically without blocking the cards", () => {
  const matchedState = baseState({
    status: "playing",
    message: "ペア成立！ +1"
  });
  const playerUi = runBrowserScript("client.js", "host");
  playerUi.socket.receive("pairMatched", matchedState);
  assert.equal(playerUi.elements.get("effectMessage").classList.contains("hidden"), false);
  const playerTimer = playerUi.timeouts.find((timer) => timer.delay === 1200 && !timer.cancelled);
  assert.ok(playerTimer);
  playerTimer.callback();
  assert.equal(playerUi.elements.get("effectMessage").classList.contains("hidden"), true);
  playerUi.socket.receive("roomUpdated", matchedState);
  assert.equal(playerUi.elements.get("effectMessage").classList.contains("hidden"), true);

  const watcherUi = runBrowserScript("watch.js", "watcher", { pathname: "/watch/1234", search: "?key=secret" });
  watcherUi.socket.receive("pairMatched", matchedState);
  assert.equal(watcherUi.elements.get("watchEffect").classList.contains("hidden"), false);
  const watcherTimer = watcherUi.timeouts.find((timer) => timer.delay === 1200 && !timer.cancelled);
  assert.ok(watcherTimer);
  watcherTimer.callback();
  assert.equal(watcherUi.elements.get("watchEffect").classList.contains("hidden"), true);
  watcherUi.socket.receive("roomUpdated", matchedState);
  assert.equal(watcherUi.elements.get("watchEffect").classList.contains("hidden"), true);

  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  assert.match(styles, /\.effect-message\s*{[^}]*pointer-events:\s*none/s);
});

test("start button is shown only to the waiting host and disappears on game start", () => {
  const { socket, elements } = runBrowserScript("client.js", "host");
  const startButton = elements.get("startButton");

  socket.receive("roomCreated", baseState());
  assert.equal(startButton.classList.contains("hidden"), false);
  assert.equal(startButton.disabled, false);

  socket.receive("gameStarted", baseState({ status: "playing" }));
  assert.equal(startButton.classList.contains("hidden"), true);
  assert.equal(startButton.disabled, true);
  assert.equal(elements.get("body").classList.contains("game-active"), true);
  assert.equal(elements.get("roomScreen").classList.contains("hidden"), true);
  assert.equal(elements.get("gameScreen").classList.contains("hidden"), false);
  assert.equal(elements.get("currentTurnStatus").textContent, "現在のターン：あなた");
  assert.equal(elements.get("turnInstruction").textContent, "2枚選んでください（0/2）");
  assert.equal(elements.get("effectMessage").classList.contains("hidden"), true);
});

test("each gameStarted event rebuilds player and watcher card elements", () => {
  const firstRound = baseState({
    status: "playing",
    cards: [
      { id: "goma-1-0", visible: false, matched: false },
      { id: "rei-1-0", visible: false, matched: false }
    ]
  });
  const secondRound = baseState({
    status: "playing",
    cards: [
      { id: "chopa-4-1", visible: false, matched: false },
      { id: "hagechopa-0", visible: false, matched: false }
    ]
  });

  const playerUi = runBrowserScript("client.js", "host");
  playerUi.socket.receive("gameStarted", firstRound);
  const firstPlayerCards = [...playerUi.elements.get("cardGrid").children];
  playerUi.socket.receive("gameStarted", secondRound);
  const secondPlayerCards = [...playerUi.elements.get("cardGrid").children];
  assert.equal(secondPlayerCards.length, 2);
  assert.notEqual(secondPlayerCards[0], firstPlayerCards[0]);
  assert.notEqual(secondPlayerCards[1], firstPlayerCards[1]);

  const watcherUi = runBrowserScript("watch.js", "watcher", { pathname: "/watch/1234", search: "?key=secret" });
  watcherUi.socket.receive("gameStarted", firstRound);
  const firstWatcherCards = [...watcherUi.elements.get("watchCardGrid").children];
  watcherUi.socket.receive("gameStarted", secondRound);
  const secondWatcherCards = [...watcherUi.elements.get("watchCardGrid").children];
  assert.equal(secondWatcherCards.length, 2);
  assert.notEqual(secondWatcherCards[0], firstWatcherCards[0]);
  assert.notEqual(secondWatcherCards[1], firstWatcherCards[1]);
});

test("a changed board identity rebuilds cards even on a generic state update", () => {
  const firstRound = baseState({
    status: "playing",
    cards: [
      { id: "goma-1-0", visible: false, matched: false },
      { id: "rei-1-0", visible: false, matched: false }
    ]
  });
  const secondRound = baseState({
    status: "playing",
    cards: [
      { id: "chopa-4-1", visible: false, matched: false },
      { id: "hagechopa-0", visible: false, matched: false }
    ]
  });

  const playerUi = runBrowserScript("client.js", "host");
  playerUi.socket.receive("gameStarted", firstRound);
  const firstPlayerCard = playerUi.elements.get("cardGrid").children[0];
  playerUi.socket.receive("roomUpdated", secondRound);
  assert.notEqual(playerUi.elements.get("cardGrid").children[0], firstPlayerCard);

  const watcherUi = runBrowserScript("watch.js", "watcher", { pathname: "/watch/1234", search: "?key=secret" });
  watcherUi.socket.receive("gameStarted", firstRound);
  const firstWatcherCard = watcherUi.elements.get("watchCardGrid").children[0];
  watcherUi.socket.receive("roomUpdated", secondRound);
  assert.notEqual(watcherUi.elements.get("watchCardGrid").children[0], firstWatcherCard);
});

test("start button stays hidden for a non-host and hides immediately after host click", () => {
  const guestUi = runBrowserScript("client.js", "guest");
  guestUi.socket.receive("roomCreated", baseState());
  assert.equal(guestUi.elements.get("startButton").classList.contains("hidden"), true);

  const hostUi = runBrowserScript("client.js", "host");
  hostUi.socket.receive("roomCreated", baseState());
  hostUi.elements.get("startButton").click();
  assert.equal(hostUi.elements.get("startButton").classList.contains("hidden"), true);
  assert.equal(hostUi.socket.emitted.at(-1)[0], "startGame");
  hostUi.socket.receive("errorMessage", { message: "開始できません" });
  assert.equal(hostUi.elements.get("startButton").classList.contains("hidden"), false);
});

test("only the host sees copy controls and they copy complete keyed URLs", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.doesNotMatch(html, /watchRoomInput|watchButton|観戦する/);

  const guestUi = runBrowserScript("client.js", "guest");
  guestUi.socket.receive("roomJoined", baseState());
  guestUi.socket.receive("hostWatchAccess", { roomId: "1234", watchKey: "secret" });
  assert.equal(guestUi.elements.get("lobbyWatchControls").classList.contains("hidden"), true);

  const hostUi = runBrowserScript("client.js", "host");
  hostUi.socket.receive("roomCreated", baseState());
  assert.equal(hostUi.elements.get("lobbyWatchControls").classList.contains("hidden"), true);
  hostUi.socket.receive("hostWatchAccess", { roomId: "1234", watchKey: "a_secure-key" });
  assert.equal(hostUi.elements.get("lobbyWatchControls").classList.contains("hidden"), false);

  hostUi.elements.get("copyLobbyWatchUrlButton").click();
  hostUi.elements.get("copyLobbyObsUrlButton").click();
  await Promise.resolve();
  assert.deepEqual(hostUi.clipboardWrites, [
    "https://game.example/watch/1234?key=a_secure-key",
    "https://game.example/obs/1234?key=a_secure-key"
  ]);

  hostUi.socket.receive("gameStarted", baseState({ status: "playing" }));
  assert.equal(hostUi.elements.get("gameWatchControls").classList.contains("hidden"), false);
});

test("the order mini-game lets each player choose once and displays the revealed order", () => {
  const { socket, elements } = runBrowserScript("client.js", "host");
  const choosing = baseState({
    status: "orderSelection",
    currentPlayerId: null,
    orderEndsAt: Date.now() + 10_000,
    orderCards: [
      { id: "order-1", chosenBy: null },
      { id: "order-2", chosenBy: null }
    ]
  });
  socket.receive("orderSelectionStarted", choosing);

  assert.equal(elements.get("orderGame").classList.contains("hidden"), false);
  assert.equal(elements.get("cardGrid").classList.contains("hidden"), true);
  assert.equal(elements.get("orderCardGrid").children.length, 2);
  elements.get("orderCardGrid").children[0].click();
  assert.equal(socket.emitted.at(-1)[0], "chooseOrderCard");
  assert.equal(socket.emitted.at(-1)[1].cardId, "order-1");

  socket.receive("orderRevealed", baseState({
    status: "orderResult",
    currentPlayerId: "host",
    turnOrder: ["host", "guest"],
    orderCards: [
      { id: "order-1", chosenBy: "host", value: 2, label: "JOKER", joker: true },
      { id: "order-2", chosenBy: "guest", value: 1, label: "1", joker: false }
    ]
  }));
  assert.equal(elements.get("orderGameTitle").textContent, "順番決定！");
  assert.equal(elements.get("orderResultList").children.length, 2);
  assert.equal(elements.get("orderResultList").children[0].children[1].textContent, "ホスト");
});

test("a player can confirm leaving from the active game screen", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /id="quitGameButton"/);
  assert.match(html, /id="quitGameModal"/);

  const { socket, elements } = runBrowserScript("client.js", "host");
  socket.receive("gameStarted", baseState({ status: "playing" }));

  elements.get("quitGameButton").click();
  assert.equal(elements.get("quitGameModal").classList.contains("hidden"), false);
  assert.notEqual(socket.emitted.at(-1)?.[0], "leaveRoom");

  elements.get("cancelQuitGameButton").click();
  assert.equal(elements.get("quitGameModal").classList.contains("hidden"), true);

  elements.get("quitGameButton").click();
  elements.get("confirmQuitGameButton").click();
  assert.equal(socket.emitted.at(-1)[0], "leaveRoom");
  assert.equal(elements.get("homeScreen").classList.contains("hidden"), false);
  assert.equal(elements.get("gameScreen").classList.contains("hidden"), true);
});

test("watch screen has no start control and switches to read-only progress display", () => {
  const watchHtml = fs.readFileSync(path.join(__dirname, "..", "public", "watch.html"), "utf8");
  assert.doesNotMatch(watchHtml, /id=["']startButton["']/);

  const { socket, elements } = runBrowserScript(
    "watch.js",
    "watcher",
    { pathname: "/watch/1234", search: "?key=secret" }
  );
  socket.receive("connect");
  assert.equal(socket.emitted[0][0], "joinWatch");
  assert.equal(socket.emitted[0][1].roomId, "1234");
  assert.equal(socket.emitted[0][1].key, "secret");
  socket.receive("watchJoined", baseState());
  assert.equal(elements.get("watchProgress").classList.contains("hidden"), true);

  socket.receive("gameStarted", baseState({ status: "playing" }));
  assert.equal(elements.get("watchProgress").classList.contains("hidden"), false);
  assert.equal(elements.get("watchCurrentTurnStatus").textContent, "現在のターン：ホスト");
  assert.equal(elements.get("watchTurnInstruction").textContent, "ホストさんが2枚選んでいます");
  assert.equal(elements.get("watchEffect").classList.contains("hidden"), true);
});

test("an invalid watch key hides all game information", () => {
  const { socket, elements } = runBrowserScript(
    "watch.js",
    "watcher",
    { pathname: "/watch/1234", search: "?key=wrong" }
  );
  socket.receive("watchUnavailable", { message: "観戦URLが無効です" });
  assert.equal(elements.get("watchStatus").textContent, "観戦URLが無効です");
  assert.equal(elements.get("body").classList.contains("watch-invalid"), true);
  assert.equal(elements.get("watchCardGrid").children.length, 0);
});

test("watchers can follow the order mini-game without being able to choose", () => {
  const { socket, elements } = runBrowserScript(
    "watch.js",
    "watcher",
    { pathname: "/watch/1234", search: "?key=secret" }
  );
  socket.receive("orderSelectionStarted", baseState({
    status: "orderSelection",
    currentPlayerId: null,
    orderEndsAt: Date.now() + 10_000,
    orderCards: [
      { id: "order-1", chosenBy: "host" },
      { id: "order-2", chosenBy: null }
    ]
  }));

  assert.equal(elements.get("watchOrderGame").classList.contains("hidden"), false);
  assert.equal(elements.get("watchOrderCards").children.length, 2);
  assert.equal(socket.emitted.some(([event]) => event === "chooseOrderCard"), false);

  socket.receive("orderRevealed", baseState({
    status: "orderResult",
    currentPlayerId: null,
    turnOrder: ["host", "guest"],
    orderCards: [
      { id: "order-1", chosenBy: "host", value: 2, label: "JOKER", joker: true },
      { id: "order-2", chosenBy: "guest", value: 1, label: "1", joker: false }
    ]
  }));
  assert.equal(elements.get("watchOrderTitle").textContent, "順番決定！");
  assert.equal(elements.get("watchOrderResult").children.length, 2);
});

test("OBS screen keeps the game start overlay hidden", () => {
  const { socket, elements } = runBrowserScript(
    "watch.js",
    "observer",
    { pathname: "/obs/1234", search: "?key=secret" }
  );

  socket.receive("gameStarted", baseState({ status: "playing" }));

  assert.equal(elements.get("watchProgress").classList.contains("hidden"), false);
  assert.equal(elements.get("watchEffect").classList.contains("hidden"), true);
});

test("sound events use the replaceable mp3 paths only after user interaction", () => {
  const { controller, documentListeners, played } = runSoundManager();
  controller.play("cardFlipped");
  assert.deepEqual(played, []);

  documentListeners.get("pointerdown")();
  controller.play("cardFlipped");
  controller.play("pairMatched");
  controller.play("pairFailed");
  controller.play("jokerActivated");
  controller.play("gameEnded");
  assert.deepEqual(played, [
    "/sounds/flip.mp3",
    "/sounds/match.mp3",
    "/sounds/miss.mp3",
    "/sounds/hgsound.mp3",
    "/sounds/finish.mp3"
  ]);
});

test("a tap primes Safari speech once before an asynchronous turn announcement", () => {
  const { controller, documentListeners, spoken } = runSoundManager();
  documentListeners.get("click")();
  documentListeners.get("click")();
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "");
  assert.equal(spoken[0].volume, 0);
  const opponentTurn = baseState({ status: "playing", currentPlayerId: "guest" });
  const myTurn = baseState({ status: "playing", currentPlayerId: "host" });
  controller.handleGameEvent("turnChanged", myTurn, opponentTurn, { selfId: "host" });
  assert.equal(spoken[1].text, "ホストさんのばんです");
  assert.equal(spoken[1].volume, controller.settings.volume);
  for (const error of ["canceled", "interrupted"]) {
    spoken[0].onerror({ error });
    documentListeners.get("click")();
    assert.equal(spoken.length, 2, "canceling initialization must not queue another utterance");
  }
});

test("turn speech runs once when an opponent hands the turn to this player", () => {
  const { controller, documentListeners, spoken } = runSoundManager();
  documentListeners.get("pointerdown")();
  const opponentTurn = baseState({ status: "playing", currentPlayerId: "guest" });
  const myTurn = baseState({ status: "playing", currentPlayerId: "host" });

  controller.handleGameEvent("turnChanged", myTurn, opponentTurn, { selfId: "host" });
  controller.handleGameEvent("roomUpdated", myTurn, myTurn, { selfId: "host" });
  controller.handleGameEvent("pairMatched", myTurn, myTurn, { selfId: "host" });
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "ホストさんのばんです");
  assert.equal(spoken[0].lang, "ja-JP");
  assert.equal(spoken[0].voice.lang, "ja-JP");
  assert.equal(spoken[0].rate, 1.3125);
});

test("all players hear the current player's name, including the opening turn", () => {
  for (const selfId of ["host", "guest"]) {
    const { controller, documentListeners, spoken } = runSoundManager();
    documentListeners.get("pointerdown")();
    const hostTurn = baseState({ status: "playing", currentPlayerId: "host" });
    const guestTurn = baseState({ status: "playing", currentPlayerId: "guest" });
    controller.handleGameEvent("gameStarted", hostTurn, baseState({ status: "ordering" }), { selfId });
    controller.handleGameEvent("turnChanged", guestTurn, hostTurn, { selfId });
    controller.handleGameEvent("turnChanged", guestTurn, guestTurn, { selfId });
    controller.handleGameEvent("pairMatched", guestTurn, guestTurn, { selfId });
    assert.deepEqual(spoken.map((utterance) => utterance.text), ["ホストさんのばんです", "ゲストさんのばんです"]);
  }
});

test("joker chance uses the dedicated mp3 without synthesized speech", () => {
  const { controller, documentListeners, played, spoken } = runSoundManager();
  documentListeners.get("pointerdown")();
  const before = baseState({ status: "playing", revealAll: false });
  const activated = baseState({ status: "playing", revealAll: true });

  controller.handleGameEvent("jokerActivated", activated, before, { selfId: "guest" });
  assert.deepEqual(played, ["/sounds/hgsound.mp3"]);
  assert.equal(spoken.length, 0);
});

test("joker countdown ticks once per displayed second and respects mute", () => {
  const { controller, documentListeners, elements, synthesized } = runSoundManager();
  documentListeners.get("pointerdown")();
  controller.playCountdownTick(6, 12345);
  controller.playCountdownTick(6, 12345);
  controller.playCountdownTick(5, 12345);
  assert.equal(synthesized.length, 2, "the 250ms timer refresh does not duplicate a second");

  const effects = elements.get("soundEffectsEnabled");
  effects.checked = false;
  effects.listeners.get("change")();
  controller.playCountdownTick(4, 12345);
  assert.equal(synthesized.length, 2, "countdown is silent when effects are muted");
});

test("sound controls persist mute, speech, and volume per screen mode", () => {
  const { controller, documentListeners, elements, played, storage } = runSoundManager("watch");
  assert.equal(controller.settings.effects, true);
  assert.equal(controller.settings.speech, false);

  const effects = elements.get("soundEffectsEnabled");
  const speech = elements.get("turnSpeechEnabled");
  const volume = elements.get("soundVolume");
  effects.checked = false;
  effects.listeners.get("change")();
  speech.checked = true;
  speech.listeners.get("change")();
  volume.value = "35";
  volume.listeners.get("input")();
  documentListeners.get("pointerdown")();
  controller.play("cardFlipped");

  assert.deepEqual(JSON.parse(storage.get("chopan-sound-settings-watch")), {
    effects: false,
    speech: true,
    volume: 0.35
  });
  assert.deepEqual(played, [], "muted effects do not play");
});

test("all requested mp3 assets and audio controls are present", () => {
  for (const filename of ["flip.mp3", "match.mp3", "miss.mp3", "hgsound.mp3", "finish.mp3"]) {
    assert.ok(fs.statSync(path.join(__dirname, "..", "public", "sounds", filename)).size > 1000);
  }
  const playerHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const watchHtml = fs.readFileSync(path.join(__dirname, "..", "public", "watch.html"), "utf8");
  assert.match(playerHtml, /id="soundEffectsEnabled"/);
  assert.match(playerHtml, /id="turnSpeechEnabled"/);
  assert.match(playerHtml, /id="soundVolume"/);
  assert.match(watchHtml, /id="watchSoundEffectsEnabled"/);
  assert.match(watchHtml, /id="watchTurnSpeechEnabled"/);
  assert.match(watchHtml, /id="watchSoundVolume"/);
});

test("joker chance uses a short burst message before the unobtrusive countdown", () => {
  const playerHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const watchHtml = fs.readFileSync(path.join(__dirname, "..", "public", "watch.html"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  assert.match(playerHtml, /id="jokerChanceBurst"[^>]*>[\s\S]*はげちょぱ[\s\S]*チャーーーーンス!!/);
  assert.match(watchHtml, /id="watchJokerChanceBurst"[^>]*>[\s\S]*はげちょぱ[\s\S]*チャーーーーンス!!/);
  assert.match(styles, /animation:\s*jokerChanceBurst 1\.05s/);
  assert.match(styles, /\.joker-chance-burst\s*{[^}]*pointer-events:\s*none/s);
});

test("joker countdown stays outside the card grid and ignores pointer input", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  const timerStyles = styles.slice(styles.indexOf(".reveal-timer {"), styles.indexOf(".reveal-timer::before"));
  assert.match(timerStyles, /margin:\s*-5px auto 5px/);
  assert.match(timerStyles, /background:\s*rgba\(255,217,126,\.76\)/);
  assert.match(timerStyles, /pointer-events:\s*none/);
  assert.doesNotMatch(timerStyles, /position:\s*fixed/);
});

test("player, watcher, and OBS countdowns use the shared server reveal deadline", () => {
  const revealState = baseState({
    status: "playing",
    revealAll: true,
    isProcessing: true,
    revealEndsAt: Date.now() + 6000
  });
  const playerUi = runBrowserScript("client.js", "host");
  playerUi.socket.receive("gameStarted", revealState);
  assert.match(playerUi.elements.get("revealTimer").innerHTML, /<strong>6<\/strong>/);
  assert.match(playerUi.elements.get("revealTimer").innerHTML, /はげちょぱチャンス/);
  assert.equal(playerUi.elements.get("jokerChanceBurst").classList.contains("hidden"), false);
  assert.equal(playerUi.elements.get("effectMessage").classList.contains("hidden"), true);

  const watcherUi = runBrowserScript("watch.js", "watcher", { pathname: "/watch/1234", search: "?key=secret" });
  watcherUi.socket.receive("watchJoined", revealState);
  assert.match(watcherUi.elements.get("watchRevealTimer").innerHTML, /<strong>6<\/strong>/);
  assert.equal(watcherUi.elements.get("watchJokerChanceBurst").classList.contains("hidden"), false);

  const obsUi = runBrowserScript("watch.js", "watcher", { pathname: "/obs/1234", search: "?key=secret" });
  obsUi.socket.receive("watchJoined", revealState);
  assert.match(obsUi.elements.get("watchRevealTimer").innerHTML, /<strong>6<\/strong>/);
  assert.equal(obsUi.elements.get("watchJokerChanceBurst").classList.contains("hidden"), false);
});

test("card placement transforms the clickable card while flip animation stays on its child", () => {
  const { document } = createDom();
  const window = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "public", "card-view.js"), "utf8"),
    { document, window },
    { filename: "card-view.js" }
  );
  let clickedIndex = null;
  const card = {
    id: "hidden-card",
    matched: false,
    visible: false,
    xOffset: 24,
    yOffset: -18,
    rotation: 8,
    zIndex: 12
  };
  const button = window.ChopanCardView.createCard(card, 5, (index) => { clickedIndex = index; });
  window.ChopanCardView.updateCard(button, card, 5, true);

  assert.equal(button.children[0].className, "card-flipper");
  assert.equal(button.children[0].children[0].className, "card-face card-back");
  assert.equal(button.children[0].children[0].children.length, 0, "the back has no directional image");
  assert.equal(button.children[0].children[0].textContent, "", "the back has no text or suit mark");
  assert.equal(button.style.values.get("--card-x"), "24px");
  assert.equal(button.style.values.get("--card-y"), "-18px");
  assert.equal(button.style.values.get("--card-rotation"), "8deg");
  assert.equal(button.style.values.get("--card-x-mobile"), "10.8px");
  assert.equal(button.style.values.get("--card-rotation-mobile"), "4.8deg");
  assert.ok(Math.abs(Number.parseFloat(button.style.values.get("--card-x-compact")) - 16.8) < 0.001);
  assert.equal(button.style.values.get("--card-y-compact"), "-12.6px");
  assert.equal(button.style.values.get("--card-rotation-compact"), "6.4deg");
  assert.equal(button.style.zIndex, "12");
  assert.equal(button.disabled, false);
  button.click();
  assert.equal(clickedIndex, 5);
});

test("card back uses one shared 180-degree symmetric design in every game view", () => {
  const cardView = fs.readFileSync(path.join(__dirname, "..", "public", "card-view.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  const player = fs.readFileSync(path.join(__dirname, "..", "public", "client.js"), "utf8");
  const watcher = fs.readFileSync(path.join(__dirname, "..", "public", "watch.js"), "utf8");
  const backStyles = styles.slice(styles.indexOf(".card-back {"), styles.indexOf(".card-front {"));

  assert.doesNotMatch(cardView, /card_back|card-back-image/);
  assert.doesNotMatch(backStyles, /[♠♥♣♦]|content:\s*["'][^"']+["']/);
  assert.match(backStyles, /repeating-conic-gradient/);
  assert.match(backStyles, /20% 20%/);
  assert.match(backStyles, /80% 80%/);
  assert.match(backStyles, /13% 13%/);
  assert.match(backStyles, /87% 87%/);
  assert.match(player, /ChopanCardView\.createCard/);
  assert.match(watcher, /ChopanCardView\.createCard/);
});

test("card fronts use high-contrast character palettes and enlarged corner identifiers", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");

  assert.match(styles, /\.card-front\.goma\s*{[^}]*--card-accent:\s*#1776dc[^}]*--card-symbol:\s*"♠"/s);
  assert.match(styles, /\.card-front\.rei\s*{[^}]*--card-accent:\s*#df354f[^}]*--card-symbol:\s*"♥"/s);
  assert.match(styles, /\.card-front\.guri\s*{[^}]*--card-accent:\s*#1d9a50[^}]*--card-symbol:\s*"♣"/s);
  assert.match(styles, /\.card-front\.chopa\s*{[^}]*--card-accent:\s*#f2a20c[^}]*--card-symbol:\s*"♦"/s);
  assert.match(styles, /\.card-front\.hagechopa\s*{[^}]*--card-accent:\s*#7b35ad[^}]*--card-light:\s*#e6c262[^}]*--card-symbol:\s*"★"/s);
  assert.match(styles, /\.card-front\.has-image \.card-corner\s*{[^}]*min-width:\s*30%[^}]*background:\s*rgba\(255,255,255,\.96\)/s);
  assert.match(styles, /\.card-front\.has-image \.card-corner b\s*{[^}]*font-size:\s*clamp\(17px,\s*2\.35vw,\s*29px\)/s);
  assert.match(styles, /\.card-front\.has-image \.card-corner i\s*{[^}]*font-size:\s*clamp\(16px,\s*2\.05vw,\s*25px\)/s);
});

test("all four chopa fronts prefer their numbered image and keep text as fallback", () => {
  const { document } = createDom();
  const window = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "public", "card-view.js"), "utf8"),
    { document, window },
    { filename: "card-view.js" }
  );

  for (let number = 1; number <= 4; number += 1) {
    const card = {
      character: "chopa",
      name: "ちょぱ",
      mark: "♦",
      number,
      joker: false,
      visible: true,
      matched: false
    };
    const button = window.ChopanCardView.createCard(card, number - 1, null);
    const front = button.children[0].children[1];
    const image = front.children[1];
    const fallback = front.children[2];

    assert.equal(image.src, `/images/chopa/chopa_${number}.png`);
    assert.equal(fallback.children[0].textContent, "ちょぱ");
    assert.equal(front.children[0].children[0].textContent, number);
    assert.equal(front.children[0].children[1].textContent, "♦");
    assert.equal(front.children[3].textContent, "ちょぱ");
    assert.equal(front.children[4].children[0].textContent, number);
    image.listeners.get("load")();
    assert.equal(image.classList.contains("hidden"), false);
    assert.equal(fallback.classList.contains("hidden"), true);
    assert.equal(front.classList.contains("has-image"), true);
  }
});

test("a missing character image leaves the text fallback visible", () => {
  const { document } = createDom();
  const window = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "public", "card-view.js"), "utf8"),
    { document, window },
    { filename: "card-view.js" }
  );
  const button = window.ChopanCardView.createCard({
    character: "missing",
    name: "フォールバック",
    mark: "♣",
    number: 1,
    joker: false
  }, 0, null);
  const front = button.children[0].children[1];
  const image = front.children[1];
  const fallback = front.children[2];

  image.listeners.get("error")();
  assert.equal(image.removed, true);
  assert.equal(fallback.classList.contains("hidden"), false);
  assert.equal(fallback.children[0].textContent, "フォールバック");
  assert.equal(front.classList.contains("has-image"), false);
});
