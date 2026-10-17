"use strict";

const watchSocket = io();
const watchRoomId = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] || "");
const watchKey = new URLSearchParams(location.search).get("key") || "";
const isObsMode = location.pathname.startsWith("/obs/");
const watchSoundController = window.ChopanAudio?.createSoundController({
  mode: isObsMode ? "obs" : "watch",
  ids: {
    effects: "watchSoundEffectsEnabled",
    speech: "watchTurnSpeechEnabled",
    volume: "watchSoundVolume",
    volumeOutput: "watchSoundVolumeValue"
  }
});
let watchState = null;
let watchRevealInterval = null;
let watchEffectTimer = null;
let dismissedWatchEffectMessage = null;
const MATCH_MESSAGE_MS = 1200;

const watchElement = (id) => document.getElementById(id);

function renderWatchCards() {
  const grid = watchElement("watchCardGrid");
  const existing = Array.from(grid.children);
  const boardChanged = existing.length !== watchState.cards.length
    || existing.some((button, index) => button.dataset.cardId !== watchState.cards[index]?.id);
  if (boardChanged) grid.replaceChildren();
  watchState.cards.forEach((card, index) => {
    let button = grid.children[index];
    if (!button) {
      button = ChopanCardView.createCard(card, index, null);
      button.dataset.cardId = card.id;
      button.tabIndex = -1;
      grid.append(button);
    }
    ChopanCardView.updateCard(button, card, index, false);
  });
}

function renderWatchPlayers() {
  watchElement("watchPlayers").replaceChildren(...watchState.players.map((player) => {
    const chip = document.createElement("div");
    chip.className = `score-chip${player.id === watchState.currentPlayerId ? " current" : ""}${!player.connected ? " disconnected" : ""}`;
    const prefix = player.id === watchState.currentPlayerId ? "▶ " : "";
    chip.append(document.createTextNode(`${prefix}${player.name} `));
    const score = document.createElement("b");
    score.textContent = `${player.score}点`;
    chip.append(score);
    return chip;
  }));
}

function renderWatchTimer() {
  clearInterval(watchRevealInterval);
  const timer = watchElement("watchRevealTimer");
  if (!watchState.revealAll) {
    timer.classList.add("hidden");
    return;
  }
  const revealEndsAt = Number(watchState.revealEndsAt);
  const updateTimer = () => {
    const seconds = Math.max(0, Math.ceil((revealEndsAt - Date.now()) / 1000));
    timer.innerHTML = seconds > 0
      ? `★ はげちょぱチャンス　残り <strong>${seconds}</strong>秒`
      : "チャンス終了！";
    watchSoundController?.playCountdownTick(seconds, revealEndsAt);
  };
  timer.classList.remove("hidden");
  updateTimer();
  watchRevealInterval = setInterval(updateTimer, 250);
}

function renderWatchResults() {
  const result = watchElement("watchResult");
  if (watchState.status !== "finished") {
    result.classList.add("hidden");
    return;
  }
  result.classList.remove("hidden");
  watchElement("watchRanking").replaceChildren(...watchState.winners.map((player) => {
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
}

function renderWatchOrderGame() {
  const active = watchState.status === "orderSelection" || watchState.status === "orderResult";
  watchElement("watchOrderGame").classList.toggle("hidden", !active);
  watchElement("watchCardGrid").classList.toggle("hidden", active);
  if (!active) return;

  const revealed = watchState.status === "orderResult";
  watchElement("watchOrderTitle").textContent = revealed ? "順番決定！" : "運命の1枚を選択中！";
  watchElement("watchOrderGuide").textContent = revealed
    ? "この順番でゲームを開始します"
    : `選択済み ${watchState.orderCards.filter((card) => card.chosenBy).length}/${watchState.players.filter((player) => player.connected).length}人`;
  watchElement("watchOrderCards").replaceChildren(...watchState.orderCards.map((card) => {
    const item = document.createElement("div");
    const owner = watchState.players.find((player) => player.id === card.chosenBy);
    item.className = `order-card${card.chosenBy ? " chosen" : ""}${card.joker ? " joker" : ""}`;
    const value = document.createElement("strong");
    value.textContent = revealed ? card.label : card.chosenBy ? "✓" : "?";
    const name = document.createElement("span");
    name.textContent = owner ? owner.name : "未選択";
    item.append(value, name);
    return item;
  }));
  const ordered = watchState.turnOrder.map((id) => watchState.players.find((player) => player.id === id)).filter(Boolean);
  watchElement("watchOrderResult").replaceChildren(...ordered.map((player, index) => {
    const row = document.createElement("div");
    row.className = "order-result-row";
    const rank = document.createElement("strong");
    rank.textContent = String(index + 1);
    const name = document.createElement("span");
    name.textContent = player.name;
    row.append(rank, name);
    return row;
  }));
  watchElement("watchOrderResult").classList.toggle("hidden", !revealed);
}

function renderWatch(nextState, eventName = "roomUpdated") {
  document.body.classList.remove("watch-invalid");
  const previousState = watchState;
  watchSoundController?.handleGameEvent(eventName, nextState, previousState);
  if (eventName === "gameStarted") watchElement("watchCardGrid").replaceChildren();
  watchState = nextState;
  watchElement("watchRoomCode").textContent = watchState.roomId;
  watchElement("watchRemainingPairs").textContent = watchState.remainingPairs;
  const current = watchState.players.find((player) => player.id === watchState.currentPlayerId);
  watchElement("watchTurnName").textContent = current ? `${current.name}の番` : "-";
  watchElement("watchCurrentTurnStatus").textContent = `現在のターン：${current?.name || "-"}`;
  watchElement("watchTurnInstruction").textContent = watchState.isProcessing
    ? "カードを判定しています…"
    : current ? `${current.name}さんが2枚選んでいます` : "次のターンを待っています";
  renderWatchPlayers();
  renderWatchOrderGame();

  const status = watchElement("watchStatus");
  if (watchState.status === "waiting") {
    status.textContent = `ゲーム開始を待っています（${watchState.players.length}人参加中）`;
    status.classList.remove("hidden", "error");
    watchElement("watchProgress").classList.add("hidden");
    watchElement("watchCardGrid").replaceChildren();
  } else {
    status.classList.add("hidden");
    watchElement("watchProgress").classList.toggle("hidden", watchState.status !== "playing");
    if (watchState.status === "playing" || watchState.status === "finished") renderWatchCards();
  }

  const effect = watchElement("watchEffect");
  if (eventName === "pairMatched") dismissedWatchEffectMessage = null;
  if (watchState.message && watchState.message !== dismissedWatchEffectMessage && watchState.status !== "finished" && !watchState.revealAll) {
    effect.textContent = watchState.message;
    effect.classList.remove("hidden");
    if (eventName === "pairMatched") {
      const message = watchState.message;
      clearTimeout(watchEffectTimer);
      watchEffectTimer = setTimeout(() => {
        dismissedWatchEffectMessage = message;
        effect.classList.add("hidden");
        watchEffectTimer = null;
      }, MATCH_MESSAGE_MS);
    }
  } else {
    if (!watchState.message || watchState.revealAll || watchState.status === "finished") {
      clearTimeout(watchEffectTimer);
      watchEffectTimer = null;
      dismissedWatchEffectMessage = null;
    }
    effect.classList.add("hidden");
  }
  watchElement("watchJokerChanceBurst").classList.toggle("hidden", !watchState.revealAll);
  renderWatchTimer();
  renderWatchResults();
}

function joinWatchRoom() {
  watchElement("watchRoomCode").textContent = watchRoomId || "----";
  watchSocket.emit("joinWatch", { roomId: watchRoomId, key: watchKey });
}

document.body.classList.toggle("obs-mode", isObsMode);

watchSocket.on("connect", joinWatchRoom);
watchSocket.on("disconnect", () => {
  const status = watchElement("watchStatus");
  status.textContent = "サーバーに再接続しています…";
  status.classList.remove("hidden");
});
watchSocket.on("watchUnavailable", ({ message }) => {
  clearInterval(watchRevealInterval);
  watchRevealInterval = null;
  document.body.classList.add("watch-invalid");
  const status = watchElement("watchStatus");
  status.textContent = message;
  status.classList.add("error");
  status.classList.remove("hidden");
  watchElement("watchCardGrid").replaceChildren();
});
[
  "watchJoined", "roomUpdated", "orderSelectionStarted", "orderCardChosen", "orderRevealed", "gameStarted", "cardFlipped", "pairMatched",
  "pairFailed", "turnChanged", "jokerActivated", "gameEnded"
].forEach((event) => watchSocket.on(event, (nextState) => renderWatch(nextState, event)));
