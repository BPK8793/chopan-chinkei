"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const PAIR_FAIL_DELAY = 1200;
const JOKER_REVEAL_DELAY = 3000;

function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function createDeck(random = Math.random) {
  const characters = [
    { key: "goma", name: "ごま", mark: "♠" },
    { key: "rei", name: "れい", mark: "♥" },
    { key: "guri", name: "ぐり", mark: "♣" },
    { key: "chopa", name: "ちょぱ", mark: "♦" }
  ];
  const cards = [];
  for (const character of characters) {
    for (let number = 1; number <= 4; number += 1) {
      for (let copy = 0; copy < 2; copy += 1) {
        cards.push({
          id: `${character.key}-${number}-${copy}`,
          pairKey: `${character.key}-${number}`,
          character: character.key,
          name: character.name,
          mark: character.mark,
          number,
          joker: false,
          matched: false
        });
      }
    }
  }
  for (let copy = 0; copy < 2; copy += 1) {
    cards.push({
      id: `hagechopa-${copy}`,
      pairKey: "hagechopa",
      character: "hagechopa",
      name: "はげちょぱ",
      mark: "JOKER",
      number: null,
      joker: true,
      matched: false
    });
  }
  return shuffle(cards, random);
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 16);
}

function generateRoomId(rooms, random = Math.random) {
  for (let attempt = 0; attempt < 9000; attempt += 1) {
    const id = String(1000 + Math.floor(random() * 9000));
    if (!rooms.has(id)) return id;
  }
  throw new Error("ルーム番号を発行できませんでした");
}

function createApplication(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: false } });
  const rooms = new Map();
  const random = options.random || Math.random;
  const failDelay = options.failDelay ?? PAIR_FAIL_DELAY;
  const jokerDelay = options.jokerDelay ?? JOKER_REVEAL_DELAY;

  app.get("/watch/:roomId", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "watch.html"));
  });
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/health", (_req, res) => res.json({ ok: true }));

  function emitError(socket, message) {
    socket.emit("errorMessage", { message });
  }

  function activePlayers(room) {
    return room.players.filter((player) => player.connected);
  }

  function currentPlayer(room) {
    return room.players[room.currentPlayerIndex] || null;
  }

  function safeCard(card, visible) {
    const base = { id: card.id, matched: card.matched, visible };
    if (!visible && !card.matched) return base;
    return {
      ...base,
      character: card.character,
      name: card.name,
      mark: card.mark,
      number: card.number,
      joker: card.joker
    };
  }

  function publicState(room) {
    const selected = new Set(room.selectedCards);
    const cards = room.cards.map((card, index) =>
      safeCard(card, card.matched || room.revealAll || selected.has(index))
    );
    return {
      roomId: room.id,
      status: room.status,
      hostId: room.hostSocketId,
      players: room.players.map(({ id, name, score, connected, rematch }) => ({
        id, name, score, connected, rematch
      })),
      currentPlayerId: currentPlayer(room)?.id || null,
      cards,
      selectedCards: [...room.selectedCards],
      isProcessing: room.isProcessing,
      revealAll: room.revealAll,
      remainingPairs: room.cards.length
        ? room.cards.filter((card) => !card.matched).length / 2
        : 17,
      message: room.message,
      winners: room.winners
    };
  }

  function broadcast(room, event = "roomUpdated") {
    io.to(room.id).to(`watch:${room.id}`).emit(event, publicState(room));
  }

  function findMembership(socket) {
    for (const room of rooms.values()) {
      const playerIndex = room.players.findIndex((player) => player.id === socket.id);
      if (playerIndex !== -1) return { room, playerIndex };
    }
    return null;
  }

  function finishGame(room) {
    room.status = "finished";
    room.isProcessing = false;
    room.revealAll = false;
    const ranking = [...room.players].sort((a, b) => b.score - a.score);
    let lastScore = null;
    let rank = 0;
    room.winners = ranking.map((player, index) => {
      if (player.score !== lastScore) rank = index + 1;
      lastScore = player.score;
      return { id: player.id, name: player.name, score: player.score, rank };
    });
    room.message = "ゲーム終了！";
    broadcast(room, "gameEnded");
  }

  function advanceTurn(room) {
    if (activePlayers(room).length === 0) return;
    let index = room.currentPlayerIndex;
    for (let checked = 0; checked < room.players.length; checked += 1) {
      index = (index + 1) % room.players.length;
      if (room.players[index]?.connected) {
        room.currentPlayerIndex = index;
        return;
      }
    }
  }

  function ensureCurrentConnected(room) {
    if (!currentPlayer(room)?.connected) advanceTurn(room);
  }

  function startRound(room) {
    room.roundId += 1;
    room.status = "playing";
    room.cards = createDeck(random);
    room.selectedCards = [];
    room.currentPlayerIndex = room.players.findIndex((player) => player.connected);
    room.currentPlayerIndex = Math.max(room.currentPlayerIndex, 0);
    room.isProcessing = false;
    room.revealAll = false;
    room.message = "ゲームスタート！";
    room.winners = [];
    room.players.forEach((player) => {
      player.score = 0;
      player.rematch = false;
    });
    broadcast(room, "gameStarted");
  }

  function returnToLobby(room) {
    room.roundId += 1;
    room.status = "waiting";
    room.cards = [];
    room.selectedCards = [];
    room.currentPlayerIndex = 0;
    room.isProcessing = false;
    room.revealAll = false;
    room.message = "";
    room.winners = [];
    room.players.forEach((player) => {
      player.score = 0;
      player.rematch = false;
    });
    broadcast(room);
  }

  function removeOrDisconnect(socket, explicit = false) {
    const membership = findMembership(socket);
    if (!membership) return;
    const { room, playerIndex } = membership;
    const player = room.players[playerIndex];
    socket.leave(room.id);

    if (room.status === "waiting" || explicit && room.status === "finished") {
      room.players.splice(playerIndex, 1);
      if (room.currentPlayerIndex >= room.players.length) room.currentPlayerIndex = 0;
    } else {
      player.connected = false;
      player.rematch = false;
      if (room.status === "playing" && playerIndex === room.currentPlayerIndex && !room.isProcessing) {
        room.selectedCards = [];
        advanceTurn(room);
      }
    }

    if (activePlayers(room).length === 0) {
      io.to(`watch:${room.id}`).emit("watchUnavailable", { message: "このルームは終了しました" });
      rooms.delete(room.id);
      return;
    }
    if (room.hostSocketId === player.id) {
      room.hostSocketId = activePlayers(room)[0].id;
    }
    broadcast(room);
  }

  io.on("connection", (socket) => {
    socket.on("joinWatch", (payload = {}) => {
      if (findMembership(socket)) {
        return socket.emit("watchUnavailable", { message: "プレイヤー接続からは観戦モードへ移れません" });
      }
      const roomId = String(payload.roomId || "").trim();
      if (!/^\d{4}$/.test(roomId)) {
        return socket.emit("watchUnavailable", { message: "ルーム番号が正しくありません" });
      }
      const room = rooms.get(roomId);
      if (!room) {
        return socket.emit("watchUnavailable", { message: "ルームが見つかりません" });
      }
      if (socket.data.watchRoomId) socket.leave(`watch:${socket.data.watchRoomId}`);
      socket.data.isWatcher = true;
      socket.data.watchRoomId = roomId;
      socket.join(`watch:${roomId}`);
      socket.emit("watchJoined", publicState(room));
    });

    socket.on("createRoom", (payload = {}) => {
      if (socket.data.isWatcher) return emitError(socket, "観戦者はゲームに参加できません");
      if (findMembership(socket)) return emitError(socket, "すでにルームに参加しています");
      const name = cleanName(payload.name);
      if (!name) return emitError(socket, "プレイヤー名を入力してください");
      const id = generateRoomId(rooms, random);
      const room = {
        id,
        hostSocketId: socket.id,
        players: [{ id: socket.id, name, score: 0, connected: true, rematch: false }],
        status: "waiting",
        cards: [],
        selectedCards: [],
        currentPlayerIndex: 0,
        isProcessing: false,
        revealAll: false,
        message: "",
        winners: [],
        roundId: 0
      };
      rooms.set(id, room);
      socket.join(id);
      socket.emit("roomCreated", publicState(room));
      broadcast(room);
    });

    socket.on("joinRoom", (payload = {}) => {
      if (socket.data.isWatcher) return emitError(socket, "観戦者はゲームに参加できません");
      if (findMembership(socket)) return emitError(socket, "すでにルームに参加しています");
      const name = cleanName(payload.name);
      const roomId = String(payload.roomId || "").trim();
      if (!name) return emitError(socket, "プレイヤー名を入力してください");
      const room = rooms.get(roomId);
      if (!room) return emitError(socket, "ルームが存在しません");
      if (room.status !== "waiting") return emitError(socket, "このルームはゲーム開始済みです");
      if (room.players.length >= MAX_PLAYERS) return emitError(socket, "ルームは満員です");
      if (room.players.some((player) => player.name === name)) {
        return emitError(socket, "同じ名前のプレイヤーがいます");
      }
      room.players.push({ id: socket.id, name, score: 0, connected: true, rematch: false });
      socket.join(room.id);
      broadcast(room);
    });

    socket.on("startGame", () => {
      const membership = findMembership(socket);
      if (!membership) return emitError(socket, "ルームに参加していません");
      const { room } = membership;
      if (room.hostSocketId !== socket.id) return emitError(socket, "開始できるのはルーム作成者だけです");
      if (room.status !== "waiting") return emitError(socket, "ゲームはすでに開始されています");
      if (activePlayers(room).length < MIN_PLAYERS) return emitError(socket, "2人以上で開始できます");
      startRound(room);
    });

    socket.on("flipCard", (payload = {}) => {
      const membership = findMembership(socket);
      if (!membership) return emitError(socket, "ルームに参加していません");
      const { room } = membership;
      const index = Number(payload.index);
      if (room.status !== "playing" || room.isProcessing || room.revealAll) return;
      if (currentPlayer(room)?.id !== socket.id) return emitError(socket, "あなたのターンではありません");
      if (!Number.isInteger(index) || index < 0 || index >= room.cards.length) return;
      if (room.cards[index].matched || room.selectedCards.includes(index)) return;

      room.selectedCards.push(index);
      room.message = "";
      broadcast(room, "cardFlipped");
      if (room.selectedCards.length < 2) return;

      room.isProcessing = true;
      const roundId = room.roundId;
      const [firstIndex, secondIndex] = room.selectedCards;
      const first = room.cards[firstIndex];
      const second = room.cards[secondIndex];
      const matched = first.pairKey === second.pairKey;

      if (matched) {
        first.matched = true;
        second.matched = true;
        const points = first.joker ? 2 : 1;
        currentPlayer(room).score += points;
        room.selectedCards = [];
        room.message = first.joker ? "はげちょぱ発動！ +2" : "ペア成立！ +1";

        if (room.cards.every((card) => card.matched)) return finishGame(room);

        if (first.joker) {
          room.revealAll = true;
          broadcast(room, "jokerActivated");
          setTimeout(() => {
            if (!rooms.has(room.id) || room.roundId !== roundId || room.status !== "playing") return;
            room.revealAll = false;
            room.isProcessing = false;
            room.message = "";
            ensureCurrentConnected(room);
            broadcast(room, "turnChanged");
          }, jokerDelay);
        } else {
          room.isProcessing = false;
          ensureCurrentConnected(room);
          broadcast(room, "pairMatched");
        }
        return;
      }

      room.message = "ざんねん…";
      broadcast(room, "pairFailed");
      setTimeout(() => {
        if (!rooms.has(room.id) || room.roundId !== roundId || room.status !== "playing") return;
        room.selectedCards = [];
        room.isProcessing = false;
        room.message = "";
        advanceTurn(room);
        broadcast(room, "turnChanged");
      }, failDelay);
    });

    socket.on("requestRematch", () => {
      const membership = findMembership(socket);
      if (!membership) return;
      const { room, playerIndex } = membership;
      if (room.status !== "finished") return;
      room.players[playerIndex].rematch = true;
      const connected = activePlayers(room);
      if (connected.length >= MIN_PLAYERS && connected.every((player) => player.rematch)) startRound(room);
      else broadcast(room);
    });

    socket.on("returnToLobby", () => {
      const membership = findMembership(socket);
      if (!membership) return;
      const { room } = membership;
      if (room.status !== "finished") return;
      if (room.hostSocketId !== socket.id) return emitError(socket, "ルームに戻せるのは作成者だけです");
      room.players = room.players.filter((player) => player.connected);
      returnToLobby(room);
    });

    socket.on("leaveRoom", () => removeOrDisconnect(socket, true));
    socket.on("disconnect", () => removeOrDisconnect(socket, false));
  });

  return {
    app,
    server,
    io,
    rooms,
    createDeck,
    start: (port = 0) => new Promise((resolve) => server.listen(port, () => resolve(server.address()))),
    close: () => new Promise((resolve) => io.close(resolve))
  };
}

if (require.main === module) {
  const instance = createApplication();
  const PORT = process.env.PORT || 3000;
  instance.server.listen(PORT, () => console.log(`chopanとチン経衰弱: http://localhost:${PORT}`));
}

module.exports = { createApplication, createDeck, shuffle };
