"use strict";

const socket = io();
let state = null;
let toastTimer = null;
let revealInterval = null;
let orderInterval = null;
let hostWatchAccess = null;

const $ = (id) => document.getElementById(id);
const screens = [$("homeScreen"), $("roomScreen"), $("gameScreen")];
const soundController = window.ChopanAudio?.createSoundController({ mode: "player" });
const RESUME_ROOM_KEY = "chopan-resume-room";
const RESUME_TOKEN_KEY = "chopan-resume-token";

function saveResumeCredentials(nextState) {
  if (!nextState?.resumeToken) return;
  localStorage.setItem(RESUME_ROOM_KEY, nextState.roomId);
  localStorage.setItem(RESUME_TOKEN_KEY, nextState.resumeToken);
}

function clearResumeCredentials() {
  localStorage.removeItem(RESUME_ROOM_KEY);
  localStorage.removeItem(RESUME_TOKEN_KEY);
}

function showScreen(screen) {
  screens.forEach((item) => item.classList.toggle("hidden", item !== screen));
  document.body.classList.toggle("game-active", screen === $("gameScreen"));
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

function renderHostWatchControls() {
  const visible = Boolean(isHost() && hostWatchAccess?.roomId === state?.roomId && hostWatchAccess.watchKey);
  $("lobbyWatchControls").classList.toggle("hidden", !visible);
  $("gameWatchControls").classList.toggle("hidden", !visible);
}

function watchUrl(kind) {
  const path = kind === "obs" ? "obs" : "watch";
  return `${window.location.origin}/${path}/${encodeURIComponent(state.roomId)}?key=${encodeURIComponent(hostWatchAccess.watchKey)}`;
}

async function copyWatchUrl(kind) {
  if (!isHost() || !hostWatchAccess?.watchKey) return;
  const label = kind === "obs" ? "OBS用URL" : "観戦URL";
  try {
    await navigator.clipboard.writeText(watchUrl(kind));
    showToast(`${label}をコピーしました`);
  } catch {
    showToast(`${label}をコピーできませんでした`);
  }
}

function renderPlayersBar() {
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
  const showStart = state.status === "waiting" && isHost();
  const canStart = showStart && state.players.filter((p) => p.connected).length >= 2;
  $("startButton").disabled = !canStart;
  $("startButton").classList.toggle("hidden", !showStart);
  $("startHint").textContent = showStart
    ? (canStart ? "準備ができたらスタート！" : "あと1人で開始できます")
    : "ルーム作成者の開始を待っています";
  renderHostWatchControls();
}

function renderGame() {
  showScreen($("gameScreen"));
  $("orderGame").classList.add("hidden");
  $("cardGrid").classList.remove("hidden");
  $("gameProgress").classList.toggle("hidden", state.status !== "playing");
  $("gameRoomCode").textContent = state.roomId;
  $("remainingPairs").textContent = state.remainingPairs;
  const current = state.players.find((player) => player.id === state.currentPlayerId);
  const currentName = current ? (current.id === socket.id ? "あなた" : current.name) : "-";
  $("turnName").textContent = current ? `${currentName}の番` : "-";
  $("currentTurnStatus").textContent = `現在のターン：${currentName}`;
  if (state.isProcessing) {
    $("turnInstruction").textContent = "カードを判定しています…";
  } else if (current?.id === socket.id) {
    $("turnInstruction").textContent = `2枚選んでください（${state.selectedCards.length}/2）`;
  } else {
    $("turnInstruction").textContent = current ? `${current.name}さんが2枚選んでいます` : "次のターンを待っています";
  }

  renderPlayersBar();

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

  if (state.message && !state.revealAll) {
    $("effectMessage").textContent = state.message;
    $("effectMessage").classList.remove("hidden");
  } else {
    $("effectMessage").classList.add("hidden");
  }
  $("jokerChanceBurst").classList.toggle("hidden", !state.revealAll);
  renderRevealTimer();
  renderHostWatchControls();
}

function renderOrderGame() {
  showScreen($("gameScreen"));
  clearInterval(orderInterval);
  $("gameRoomCode").textContent = state.roomId;
  $("turnName").textContent = "順番決め";
  $("remainingPairs").textContent = "17";
  $("gameProgress").classList.add("hidden");
  $("cardGrid").classList.add("hidden");
  $("effectMessage").classList.add("hidden");
  $("jokerChanceBurst").classList.add("hidden");
  $("revealTimer").classList.add("hidden");
  $("orderGame").classList.remove("hidden");
  renderPlayersBar();
  renderHostWatchControls();

  const selectedByMe = state.orderCards.some((card) => card.chosenBy === socket.id);
  $("orderGameTitle").textContent = state.status === "orderResult" ? "順番決定！" : "運命の1枚を選ぼう！";
  $("orderGameGuide").textContent = state.status === "orderResult"
    ? "この順番でゲームを開始します"
    : selectedByMe ? "みんなが選び終わるのを待っています…" : "数字が大きい人からスタート。JOKERは最優先！";

  $("orderCardGrid").replaceChildren(...state.orderCards.map((card) => {
    const button = document.createElement("button");
    const owner = state.players.find((player) => player.id === card.chosenBy);
    button.type = "button";
    button.className = `order-card${card.chosenBy ? " chosen" : ""}${card.joker ? " joker" : ""}`;
    button.disabled = state.status !== "orderSelection" || selectedByMe || Boolean(card.chosenBy);
    if (state.status === "orderResult") {
      const value = document.createElement("strong");
      value.textContent = card.label;
      const name = document.createElement("span");
      name.textContent = owner?.name || "自動選択";
      button.append(value, name);
    } else {
      const mark = document.createElement("strong");
      mark.textContent = card.chosenBy ? "✓" : "?";
      const name = document.createElement("span");
      name.textContent = owner ? `${owner.name}が選択` : "このカードを選ぶ";
      button.append(mark, name);
      button.addEventListener("click", () => socket.emit("chooseOrderCard", { cardId: card.id }));
    }
    return button;
  }));

  const resultPlayers = state.turnOrder.map((id) => state.players.find((player) => player.id === id)).filter(Boolean);
  $("orderResultList").replaceChildren(...resultPlayers.map((player, index) => {
    const row = document.createElement("div");
    row.className = "order-result-row";
    const rank = document.createElement("strong");
    rank.textContent = `${index + 1}`;
    const name = document.createElement("span");
    name.textContent = player.name;
    row.append(rank, name);
    return row;
  }));
  $("orderResultList").classList.toggle("hidden", state.status !== "orderResult");

  const updateTimer = () => {
    if (state.status !== "orderSelection") {
      $("orderGameTimer").textContent = "まもなくゲームスタート！";
      return;
    }
    const seconds = Math.max(0, Math.ceil((Number(state.orderEndsAt) - Date.now()) / 1000));
    const chosen = state.orderCards.filter((card) => card.chosenBy).length;
    $("orderGameTimer").textContent = `選択済み ${chosen}/${state.players.filter((player) => player.connected).length}人　残り${seconds}秒`;
  };
  updateTimer();
  if (state.status === "orderSelection") orderInterval = setInterval(updateTimer, 250);
}

function renderRevealTimer() {
  clearInterval(revealInterval);
  if (!state?.revealAll) {
    $("revealTimer").classList.add("hidden");
    return;
  }
  const revealEndsAt = Number(state.revealEndsAt);
  const updateTimer = () => {
    const seconds = Math.max(0, Math.ceil((revealEndsAt - Date.now()) / 1000));
    $("revealTimer").innerHTML = seconds > 0
      ? `★ はげちょぱチャンス　残り <strong>${seconds}</strong>秒`
      : "チャンス終了！";
    soundController?.playCountdownTick(seconds, revealEndsAt);
  };
  $("revealTimer").classList.remove("hidden");
  updateTimer();
  revealInterval = setInterval(updateTimer, 250);
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

function applyState(next, eventName = "roomUpdated") {
  const previousState = state;
  saveResumeCredentials(next);
  soundController?.handleGameEvent(eventName, next, previousState, { selfId: socket.id });
  state = next;
  if (state.status !== "waiting") {
    $("startButton").classList.add("hidden");
    $("startButton").disabled = true;
  }
  if (state.status === "waiting") {
    $("resultModal").classList.add("hidden");
    renderLobby();
  } else if (state.status === "orderSelection" || state.status === "orderResult") {
    $("resultModal").classList.add("hidden");
    renderOrderGame();
  } else if (state.status === "playing") {
    $("resultModal").classList.add("hidden");
    renderGame();
  } else if (state.status === "finished") {
    renderResults();
  }
}

socket.on("connect", () => {
  $("connectionBanner").classList.add("hidden");
  const roomId = localStorage.getItem(RESUME_ROOM_KEY);
  const resumeToken = localStorage.getItem(RESUME_TOKEN_KEY);
  if (roomId && resumeToken) socket.emit("resumeRoom", { roomId, resumeToken });
});
socket.on("disconnect", () => $("connectionBanner").classList.remove("hidden"));
socket.on("connect_error", () => $("connectionBanner").classList.remove("hidden"));
[
  "roomCreated", "roomJoined", "roomResumed", "roomUpdated", "orderSelectionStarted", "orderCardChosen", "orderRevealed", "gameStarted", "cardFlipped", "pairMatched",
  "pairFailed", "turnChanged", "jokerActivated", "gameEnded"
].forEach((event) => socket.on(event, (next) => applyState(next, event)));
socket.on("errorMessage", ({ message }) => {
  showToast(message);
  // 開始要求が拒否された場合は、最新の待機状態に合う表示へ戻す。
  if (state?.status === "waiting") renderLobby();
});
socket.on("resumeUnavailable", () => clearResumeCredentials());
socket.on("hostWatchAccess", (access) => {
  hostWatchAccess = access;
  if (state) renderHostWatchControls();
});

$("createButton").addEventListener("click", () => socket.emit("createRoom", { name: saveName() }));
$("joinButton").addEventListener("click", () => socket.emit("joinRoom", { name: saveName(), roomId: $("roomInput").value }));
function normalizeRoomInput(event) {
  event.target.value = event.target.value.replace(/\D/g, "").slice(0, 4);
}

$("roomInput").addEventListener("input", normalizeRoomInput);
$("roomInput").addEventListener("keydown", (event) => { if (event.key === "Enter") $("joinButton").click(); });
$("startButton").addEventListener("click", () => {
  // 二重送信を防ぎ、サーバーからの開始通知を待つ間もボタンを残さない。
  $("startButton").classList.add("hidden");
  $("startButton").disabled = true;
  $("startHint").textContent = "ゲームを開始しています…";
  socket.emit("startGame");
});
$("leaveRoomButton").addEventListener("click", () => {
  socket.emit("leaveRoom");
  clearResumeCredentials();
  state = null;
  showScreen($("homeScreen"));
});
$("quitGameButton").addEventListener("click", () => {
  $("quitGameModal").classList.remove("hidden");
});
$("cancelQuitGameButton").addEventListener("click", () => {
  $("quitGameModal").classList.add("hidden");
});
$("confirmQuitGameButton").addEventListener("click", () => {
  socket.emit("leaveRoom");
  clearResumeCredentials();
  state = null;
  $("quitGameModal").classList.add("hidden");
  $("resultModal").classList.add("hidden");
  showScreen($("homeScreen"));
});
$("copyRoomButton").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(state.roomId); showToast("ルーム番号をコピーしました"); }
  catch { showToast(`ルーム番号は ${state.roomId} です`); }
});
$("copyLobbyWatchUrlButton").addEventListener("click", () => copyWatchUrl("watch"));
$("copyLobbyObsUrlButton").addEventListener("click", () => copyWatchUrl("obs"));
$("copyGameWatchUrlButton").addEventListener("click", () => copyWatchUrl("watch"));
$("copyGameObsUrlButton").addEventListener("click", () => copyWatchUrl("obs"));
$("rematchButton").addEventListener("click", () => socket.emit("requestRematch"));
$("lobbyButton").addEventListener("click", () => socket.emit("returnToLobby"));
$("topButton").addEventListener("click", () => {
  socket.emit("leaveRoom");
  clearResumeCredentials();
  window.location.reload();
});

$("playerName").value = localStorage.getItem("chopan-player-name") || "";
