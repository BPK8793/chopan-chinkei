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
    localStorage: { getItem: () => "", setItem: () => {}, removeItem: () => {} },
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
