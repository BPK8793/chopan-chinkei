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
    this.dataset = {};
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(event, handler) { this.listeners.set(event, handler); }
  click() { this.listeners.get("click")?.({ target: this }); }
  setAttribute() {}
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
      body: new FakeElement("body"),
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
    remainingPairs: 17,
    message: "",
    winners: [],
    ...overrides
  };
}

function runBrowserScript(filename, socketId, location = { pathname: "/", search: "" }) {
  const { document, elements } = createDom();
  const socket = new FakeSocket(socketId);
  const context = {
    document,
    io: () => socket,
    localStorage: { getItem: () => "", setItem: () => {} },
    location,
    navigator: { clipboard: { writeText: async () => {} } },
    window: { location: { assign: () => {}, reload: () => {} }, open: () => {} },
    ChopanCardView: { createCard: () => new FakeElement(), updateCard: () => {} },
    URLSearchParams,
    clearInterval: () => {},
    clearTimeout: () => {},
    setInterval: () => 1,
    setTimeout: () => 1
  };
  context.window.location.pathname = location.pathname;
  context.window.location.search = location.search;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "public", filename), "utf8"),
    context,
    { filename }
  );
  return { socket, elements };
}

test("start button is shown only to the waiting host and disappears on game start", () => {
  const { socket, elements } = runBrowserScript("client.js", "host");
  const startButton = elements.get("startButton");

  socket.receive("roomCreated", baseState());
  assert.equal(startButton.classList.contains("hidden"), false);
  assert.equal(startButton.disabled, false);

  socket.receive("gameStarted", baseState({ status: "playing" }));
  assert.equal(startButton.classList.contains("hidden"), true);
  assert.equal(startButton.disabled, true);
  assert.equal(elements.get("roomScreen").classList.contains("hidden"), true);
  assert.equal(elements.get("gameScreen").classList.contains("hidden"), false);
  assert.equal(elements.get("currentTurnStatus").textContent, "現在のターン：あなた");
  assert.equal(elements.get("turnInstruction").textContent, "2枚選んでください（0/2）");
  assert.equal(elements.get("effectMessage").classList.contains("hidden"), true);
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

test("watch screen has no start control and switches to read-only progress display", () => {
  const watchHtml = fs.readFileSync(path.join(__dirname, "..", "public", "watch.html"), "utf8");
  assert.doesNotMatch(watchHtml, /id=["']startButton["']/);

  const { socket, elements } = runBrowserScript(
    "watch.js",
    "watcher",
    { pathname: "/watch/1234", search: "" }
  );
  socket.receive("watchJoined", baseState());
  assert.equal(elements.get("watchProgress").classList.contains("hidden"), true);

  socket.receive("gameStarted", baseState({ status: "playing" }));
  assert.equal(elements.get("watchProgress").classList.contains("hidden"), false);
  assert.equal(elements.get("watchCurrentTurnStatus").textContent, "現在のターン：ホスト");
  assert.equal(elements.get("watchTurnInstruction").textContent, "ホストさんが2枚選んでいます");
  assert.equal(elements.get("watchEffect").classList.contains("hidden"), true);
});

test("OBS screen keeps the game start overlay hidden", () => {
  const { socket, elements } = runBrowserScript(
    "watch.js",
    "observer",
    { pathname: "/watch/1234", search: "?obs=1" }
  );

  socket.receive("gameStarted", baseState({ status: "playing" }));

  assert.equal(elements.get("watchProgress").classList.contains("hidden"), false);
  assert.equal(elements.get("watchEffect").classList.contains("hidden"), true);
});
