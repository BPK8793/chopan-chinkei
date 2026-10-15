"use strict";

const watchSocket = io();
const watchRoomId = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] || "");
const isObsMode = new URLSearchParams(location.search).get("obs") === "1";
let watchState = null;
let watchRevealInterval = null;

const watchElement = (id) => document.getElementById(id);

function renderWatchCards() {
  const grid = watchElement("watchCardGrid");
  if (grid.children.length !== watchState.cards.length) grid.replaceChildren();
  watchState.cards.forEach((card, index) => {
    let button = grid.children[index];
    if (!button) {
      button = ChopanCardView.createCard(card, index, null);
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
  let seconds = 3;
  timer.classList.remove("hidden");
  timer.innerHTML = `全カード公開 <strong>${seconds}</strong>`;
  watchRevealInterval = setInterval(() => {
    seconds -= 1;
    if (seconds > 0) timer.innerHTML = `全カード公開 <strong>${seconds}</strong>`;
    else clearInterval(watchRevealInterval);
  }, 1000);
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

function renderWatch(nextState) {
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

  const status = watchElement("watchStatus");
  if (watchState.status === "waiting") {
    status.textContent = `ゲーム開始を待っています（${watchState.players.length}人参加中）`;
    status.classList.remove("hidden", "error");
    watchElement("watchProgress").classList.add("hidden");
    watchElement("watchCardGrid").replaceChildren();
  } else {
    status.classList.add("hidden");
    watchElement("watchProgress").classList.toggle("hidden", watchState.status !== "playing");
    renderWatchCards();
  }

  const effect = watchElement("watchEffect");
  if (watchState.message && watchState.status !== "finished") {
    effect.textContent = watchState.message;
    effect.classList.remove("hidden");
  } else {
    effect.classList.add("hidden");
  }
  renderWatchTimer();
  renderWatchResults();
}

function joinWatchRoom() {
  watchElement("watchRoomCode").textContent = watchRoomId || "----";
  watchSocket.emit("joinWatch", { roomId: watchRoomId });
}

document.body.classList.toggle("obs-mode", isObsMode);
watchElement("openObsButton").addEventListener("click", () => {
  const obsUrl = `/watch/${encodeURIComponent(watchRoomId)}?obs=1`;
  window.open(obsUrl, "_blank", "noopener");
});

watchSocket.on("connect", joinWatchRoom);
watchSocket.on("disconnect", () => {
  const status = watchElement("watchStatus");
  status.textContent = "サーバーに再接続しています…";
  status.classList.remove("hidden");
});
watchSocket.on("watchUnavailable", ({ message }) => {
  const status = watchElement("watchStatus");
  status.textContent = message;
  status.classList.add("error");
  status.classList.remove("hidden");
  watchElement("watchCardGrid").replaceChildren();
});
[
  "watchJoined", "roomUpdated", "gameStarted", "cardFlipped", "pairMatched",
  "pairFailed", "turnChanged", "jokerActivated", "gameEnded"
].forEach((event) => watchSocket.on(event, renderWatch));
