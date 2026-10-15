"use strict";

const socket = io();
let state = null;
let toastTimer = null;
let revealInterval = null;

const $ = (id) => document.getElementById(id);
const screens = [$("homeScreen"), $("roomScreen"), $("gameScreen")];

function showScreen(screen) {
  screens.forEach((item) => item.classList.toggle("hidden", item !== screen));
}

function showToast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");
  toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 3500);
}

function saveName() {
  const name = $("playerName").value.trim();
  if (name) localStorage.setItem("chopan-player-name", name);
  return name;
}

function isHost() {
  return state?.hostId === socket.id;
}

function renderLobby() {
  showScreen($("roomScreen"));
  $("roomCode").textContent = state.roomId;
  $("playerCount").textContent = `${state.players.length} / 4人`;
  $("lobbyPlayers").replaceChildren(...state.players.map((player, index) => {
    const row = document.createElement("div");
    row.className = "lobby-player";
    const avatar = document.createElement("span");
    avatar.className = "player-avatar";
    avatar.textContent = ["♠", "♥", "♣", "♦"][index];
    const name = document.createElement("span");
    name.textContent = player.name;
    row.append(avatar, name);
    if (player.id === state.hostId) {
      const host = document.createElement("span");
      host.className = "host-chip";
      host.textContent = "ルーム主";
      row.append(host);
    }
    return row;
  }));
  const canStart = isHost() && state.players.filter((p) => p.connected).length >= 2;
  $("startButton").disabled = !canStart;
  $("startButton").classList.toggle("hidden", !isHost());
  $("startHint").textContent = isHost()
    ? (canStart ? "準備ができたらスタート！" : "あと1人で開始できます")
    : "ルーム作成者の開始を待っています";
}

function renderGame() {
  showScreen($("gameScreen"));
  $("gameRoomCode").textContent = state.roomId;
  $("remainingPairs").textContent = state.remainingPairs;
  const current = state.players.find((player) => player.id === state.currentPlayerId);
  $("turnName").textContent = current ? `${current.id === socket.id ? "あなた" : current.name}の番` : "-";

  $("playersBar").replaceChildren(...state.players.map((player) => {
    const chip = document.createElement("div");
    chip.className = `score-chip${player.id === state.currentPlayerId ? " current" : ""}${!player.connected ? " disconnected" : ""}`;
    const prefix = player.id === state.currentPlayerId ? "▶ " : "";
    chip.append(document.createTextNode(`${prefix}${player.name} `));
    const score = document.createElement("b");
    score.textContent = `${player.score}点`;
    chip.append(score);
    if (!player.connected) chip.title = "退出済み";
    return chip;
  }));

  const canFlip = state.currentPlayerId === socket.id && !state.isProcessing && !state.revealAll;
  const existing = Array.from($("cardGrid").children);
  if (existing.length !== state.cards.length) $("cardGrid").replaceChildren();
  state.cards.forEach((card, index) => {
    let button = $("cardGrid").children[index];
    if (!button) {
      button = ChopanCardView.createCard(card, index, (cardIndex) => {
        socket.emit("flipCard", { index: cardIndex });
      });
      $("cardGrid").append(button);
    }
    ChopanCardView.updateCard(button, card, index, canFlip);
  });

  if (state.message) {
    $("effectMessage").textContent = state.message;
    $("effectMessage").classList.remove("hidden");
  } else {
    $("effectMessage").classList.add("hidden");
  }
  renderRevealTimer();
}

function renderRevealTimer() {
  clearInterval(revealInterval);
  if (!state?.revealAll) {
    $("revealTimer").classList.add("hidden");
    return;
  }
  let seconds = 3;
  $("revealTimer").classList.remove("hidden");
  $("revealTimer").innerHTML = `全カード公開 <strong>${seconds}</strong>`;
  revealInterval = setInterval(() => {
    seconds -= 1;
    if (seconds > 0) $("revealTimer").innerHTML = `全カード公開 <strong>${seconds}</strong>`;
    else clearInterval(revealInterval);
  }, 1000);
}

function renderResults() {
  renderGame();
  $("resultModal").classList.remove("hidden");
  $("ranking").replaceChildren(...state.winners.map((player) => {
    const row = document.createElement("div");
    row.className = "rank-row";
    const rank = document.createElement("span");
    rank.textContent = `${player.rank}位`;
    const name = document.createElement("span");
    name.textContent = player.name;
    const score = document.createElement("strong");
    score.textContent = `${player.score}点`;
    row.append(rank, name, score);
    return row;
  }));
  const me = state.players.find((player) => player.id === socket.id);
  $("rematchButton").disabled = Boolean(me?.rematch);
  const votes = state.players.filter((player) => player.connected && player.rematch).length;
  const total = state.players.filter((player) => player.connected).length;
  $("rematchHint").textContent = me?.rematch ? `再戦を待っています（${votes}/${total}）` : "全員が押すと再戦します";
  $("lobbyButton").classList.toggle("hidden", !isHost());
}

function applyState(next) {
  state = next;
  if (state.status === "waiting") {
    $("resultModal").classList.add("hidden");
    renderLobby();
  } else if (state.status === "playing") {
    $("resultModal").classList.add("hidden");
    renderGame();
  } else if (state.status === "finished") {
    renderResults();
  }
}

socket.on("connect", () => $("connectionBanner").classList.add("hidden"));
socket.on("disconnect", () => $("connectionBanner").classList.remove("hidden"));
socket.on("connect_error", () => $("connectionBanner").classList.remove("hidden"));
[
  "roomCreated", "roomUpdated", "gameStarted", "cardFlipped", "pairMatched",
  "pairFailed", "turnChanged", "jokerActivated", "gameEnded"
].forEach((event) => socket.on(event, applyState));
socket.on("errorMessage", ({ message }) => showToast(message));

$("createButton").addEventListener("click", () => socket.emit("createRoom", { name: saveName() }));
$("joinButton").addEventListener("click", () => socket.emit("joinRoom", { name: saveName(), roomId: $("roomInput").value }));
function normalizeRoomInput(event) {
  event.target.value = event.target.value.replace(/\D/g, "").slice(0, 4);
}

$("roomInput").addEventListener("input", normalizeRoomInput);
$("roomInput").addEventListener("keydown", (event) => { if (event.key === "Enter") $("joinButton").click(); });
$("watchRoomInput").addEventListener("input", (event) => {
  normalizeRoomInput(event);
  $("watchInputError").classList.add("hidden");
});
$("watchRoomInput").addEventListener("keydown", (event) => { if (event.key === "Enter") $("watchButton").click(); });
$("watchButton").addEventListener("click", () => {
  const roomId = $("watchRoomInput").value.trim();
  if (!/^\d{4}$/.test(roomId)) {
    $("watchInputError").textContent = "4桁のルームコードを入力してください";
    $("watchInputError").classList.remove("hidden");
    return;
  }
  window.location.assign(`/watch/${roomId}`);
});
$("startButton").addEventListener("click", () => socket.emit("startGame"));
$("leaveRoomButton").addEventListener("click", () => { socket.emit("leaveRoom"); state = null; showScreen($("homeScreen")); });
$("copyRoomButton").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(state.roomId); showToast("ルーム番号をコピーしました"); }
  catch { showToast(`ルーム番号は ${state.roomId} です`); }
});
$("rematchButton").addEventListener("click", () => socket.emit("requestRematch"));
$("lobbyButton").addEventListener("click", () => socket.emit("returnToLobby"));
$("topButton").addEventListener("click", () => { socket.emit("leaveRoom"); window.location.reload(); });

$("playerName").value = localStorage.getItem("chopan-player-name") || "";
