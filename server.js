"use strict";

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const CARD_DISPLAY_TIMINGS = Object.freeze({
  mismatchMs: 2200,
  jokerRevealMs: 6000
});
const ORDER_GAME_TIMINGS = Object.freeze({
  choiceMs: 10_000,
  revealMs: 3500
});
const ROOM_DISCONNECT_GRACE_MS = 60_000;
const CARD_LAYOUT = Object.freeze({
  X_OFFSET_MAX: 30,
  Y_OFFSET_MAX: 30,
  MAX_ROTATION: 10,
  MIN_CENTER_DISTANCE: 82,
  REFERENCE_CARD_WIDTH: 100,
  REFERENCE_CARD_HEIGHT: 133,
  COLUMN_GAP: 10,
  ROW_GAP: 12,
  VALIDATED_COLUMNS: [4, 6, 7, 9],
  MAX_ATTEMPTS: 32
});

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

function roundLayoutValue(value) {
  return Math.round(value * 10) / 10;
}

function layoutDistance(first, second, columns) {
  const firstColumn = first.index % columns;
  const firstRow = Math.floor(first.index / columns);
  const secondColumn = second.index % columns;
  const secondRow = Math.floor(second.index / columns);
  const baseX = CARD_LAYOUT.REFERENCE_CARD_WIDTH + CARD_LAYOUT.COLUMN_GAP;
  const baseY = CARD_LAYOUT.REFERENCE_CARD_HEIGHT + CARD_LAYOUT.ROW_GAP;
  const dx = (firstColumn - secondColumn) * baseX + first.xOffset - second.xOffset;
  const dy = (firstRow - secondRow) * baseY + first.yOffset - second.yOffset;
  return Math.hypot(dx, dy);
}

function minimumLayoutDistance(candidate, placements) {
  if (!placements.length) return Infinity;
  let minimum = Infinity;
  for (const placement of placements) {
    for (const columns of CARD_LAYOUT.VALIDATED_COLUMNS) {
      minimum = Math.min(minimum, layoutDistance(candidate, placement, columns));
    }
  }
  return minimum;
}

function createCardLayout(cardCount, random = Math.random) {
  const placements = [];
  for (let index = 0; index < cardCount; index += 1) {
    let chosen = null;
    let bestDistance = -Infinity;
    for (let attempt = 0; attempt < CARD_LAYOUT.MAX_ATTEMPTS; attempt += 1) {
      const candidate = {
        index,
        xOffset: roundLayoutValue((random() * 2 - 1) * CARD_LAYOUT.X_OFFSET_MAX),
        yOffset: roundLayoutValue((random() * 2 - 1) * CARD_LAYOUT.Y_OFFSET_MAX),
        rotation: roundLayoutValue((random() * 2 - 1) * CARD_LAYOUT.MAX_ROTATION),
        zIndex: 1 + Math.floor(random() * 20)
      };
      const distance = minimumLayoutDistance(candidate, placements);
      if (distance > bestDistance) {
        chosen = candidate;
        bestDistance = distance;
      }
      if (distance >= CARD_LAYOUT.MIN_CENTER_DISTANCE) break;
    }
    placements.push(chosen);
  }
  return placements.map(({ index: _index, ...placement }) => placement);
}

function applyCardLayout(cards, random = Math.random) {
  const layout = createCardLayout(cards.length, random);
  return cards.map((card, index) => ({ ...card, ...layout[index] }));
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

function generateWatchKey() {
  return crypto.randomBytes(32).toString("base64url");
}

function watchKeyMatches(room, suppliedKey) {
  const expected = Buffer.from(room.watchKey);
  const supplied = Buffer.from(String(suppliedKey || ""));
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function createApplication(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: false } });
  const rooms = new Map();
  const random = options.random || Math.random;
  const failDelay = options.failDelay ?? CARD_DISPLAY_TIMINGS.mismatchMs;
  const jokerDelay = options.jokerDelay ?? CARD_DISPLAY_TIMINGS.jokerRevealMs;
  const orderChoiceMs = options.orderChoiceMs ?? ORDER_GAME_TIMINGS.choiceMs;
  const orderRevealMs = options.orderRevealMs ?? ORDER_GAME_TIMINGS.revealMs;
  const skipOrderGame = options.skipOrderGame === true;
  const disconnectGraceMs = options.disconnectGraceMs ?? ROOM_DISCONNECT_GRACE_MS;
  const pendingDisconnects = new Map();

  app.get(["/watch/:roomId", "/obs/:roomId"], (_req, res) => {
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
    const base = {
      id: card.id,
      matched: card.matched,
      visible,
      xOffset: card.xOffset,
      yOffset: card.yOffset,
      rotation: card.rotation,
      zIndex: card.zIndex
    };
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
      currentPlayerId: room.status === "playing" ? currentPlayer(room)?.id || null : null,
      cards,
      selectedCards: [...room.selectedCards],
      isProcessing: room.isProcessing,
      revealAll: room.revealAll,
      revealEndsAt: room.revealEndsAt,
      remainingPairs: room.cards.length
        ? room.cards.filter((card) => !card.matched).length / 2
        : 17,
      message: room.message,
      winners: room.winners,
      orderEndsAt: room.orderEndsAt,
      turnOrder: [...room.turnOrder],
      orderCards: room.orderCards.map((card) => ({
        id: card.id,
        chosenBy: card.chosenBy,
        ...(room.orderRevealed ? {
          value: card.value,
          label: card.joker ? "JOKER" : String(card.value),
          joker: card.joker
        } : {})
      }))
    };
  }

  function broadcast(room, event = "roomUpdated") {
    io.to(room.id).to(`watch:${room.id}`).emit(event, publicState(room));
    io.to(room.hostSocketId).emit("hostWatchAccess", {
      roomId: room.id,
      watchKey: room.watchKey
    });
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
    room.revealEndsAt = null;
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

  function cancelDisconnectCleanup(player) {
    const timer = pendingDisconnects.get(player.resumeToken);
    if (!timer) return;
    clearTimeout(timer);
    pendingDisconnects.delete(player.resumeToken);
  }

  function closeEmptyRoom(room) {
    if (activePlayers(room).length > 0) return false;
    room.players.forEach(cancelDisconnectCleanup);
    io.to(`watch:${room.id}`).emit("watchUnavailable", { message: "このルームは終了しました" });
    rooms.delete(room.id);
    return true;
  }

  function removePlayerRecord(room, playerIndex) {
    const player = room.players[playerIndex];
    if (!player) return null;

    const wasCurrentPlayer = room.status === "playing" && playerIndex === room.currentPlayerIndex;
    if (wasCurrentPlayer) {
      // Any pending pair/joker callback belongs to the departed player's turn.
      room.roundId += 1;
      room.selectedCards = [];
      room.isProcessing = false;
      room.revealAll = false;
      room.revealEndsAt = null;
      room.message = "";
    }

    room.players.splice(playerIndex, 1);
    if (room.status === "orderSelection") {
      const selected = room.orderCards.find((card) => card.chosenBy === player.id);
      if (selected) selected.chosenBy = null;
    }
    room.turnOrder = room.turnOrder.filter((id) => id !== player.id);
    if (playerIndex < room.currentPlayerIndex) room.currentPlayerIndex -= 1;
    if (room.currentPlayerIndex >= room.players.length) room.currentPlayerIndex = 0;
    if (room.status === "playing" && room.players.length > 0) ensureCurrentConnected(room);
    if (room.hostSocketId === player.id && activePlayers(room).length > 0) {
      room.hostSocketId = activePlayers(room)[0].id;
    }
    return player;
  }

  function scheduleDisconnectCleanup(room, player) {
    cancelDisconnectCleanup(player);
    const timer = setTimeout(() => {
      pendingDisconnects.delete(player.resumeToken);
      const currentRoom = rooms.get(room.id);
      if (!currentRoom) return;
      const playerIndex = currentRoom.players.findIndex(
        (candidate) => candidate.resumeToken === player.resumeToken
      );
      if (playerIndex === -1 || currentRoom.players[playerIndex].connected) return;

      if (closeEmptyRoom(currentRoom)) return;
      removePlayerRecord(currentRoom, playerIndex);
      if (currentRoom.status === "orderSelection" && activePlayers(currentRoom).every((candidate) =>
        currentRoom.orderCards.some((card) => card.chosenBy === candidate.id)
      )) {
        finishOrderSelection(currentRoom);
        return;
      }
      broadcast(currentRoom);
    }, disconnectGraceMs);
    timer.unref?.();
    pendingDisconnects.set(player.resumeToken, timer);
  }

  function resetRoundState(room) {
    room.cards = [];
    room.selectedCards = [];
    room.currentPlayerIndex = 0;
    room.isProcessing = false;
    room.revealAll = false;
    room.revealEndsAt = null;
    room.message = "";
    room.winners = [];
    room.orderCards = [];
    room.orderEndsAt = null;
    room.orderRevealed = false;
    room.turnOrder = [];
    room.players.forEach((player) => {
      player.score = 0;
      player.rematch = false;
    });
  }

  function startRound(room, roundId = room.roundId) {
    if (!rooms.has(room.id) || room.roundId !== roundId) return;
    room.status = "playing";
    room.cards = applyCardLayout(createDeck(random), random);
    room.selectedCards = [];
    room.currentPlayerIndex = room.players.findIndex((player) => player.connected);
    room.currentPlayerIndex = Math.max(room.currentPlayerIndex, 0);
    room.isProcessing = false;
    room.revealAll = false;
    room.revealEndsAt = null;
    room.message = "";
    room.winners = [];
    room.orderEndsAt = null;
    broadcast(room, "gameStarted");
  }

  function finishOrderSelection(room, roundId = room.roundId) {
    if (!rooms.has(room.id) || room.roundId !== roundId || room.status !== "orderSelection") return;
    const connected = activePlayers(room);
    const available = room.orderCards.filter((card) => !card.chosenBy);
    for (const player of connected.filter((candidate) =>
      !room.orderCards.some((card) => card.chosenBy === candidate.id)
    )) {
      const card = available.shift();
      if (card) card.chosenBy = player.id;
    }

    const chosenValue = new Map(room.orderCards.map((card) => [card.chosenBy, card.value]));
    const orderedConnected = [...connected].sort((a, b) => chosenValue.get(b.id) - chosenValue.get(a.id));
    const disconnected = room.players.filter((player) => !player.connected);
    room.players = [...orderedConnected, ...disconnected];
    room.currentPlayerIndex = 0;
    room.turnOrder = orderedConnected.map((player) => player.id);
    room.orderRevealed = true;
    room.orderEndsAt = null;
    room.status = "orderResult";
    broadcast(room, "orderRevealed");
    const timer = setTimeout(() => startRound(room, roundId), orderRevealMs);
    timer.unref?.();
  }

  function startOrderSelection(room) {
    room.roundId += 1;
    resetRoundState(room);
    if (skipOrderGame) return startRound(room);

    const connected = activePlayers(room);
    const values = Array.from({ length: connected.length }, (_value, index) => ({
      value: index + 1,
      joker: index === connected.length - 1
    }));
    room.orderCards = shuffle(values, random).map((card, index) => ({
      id: `order-${room.roundId}-${index}`,
      ...card,
      chosenBy: null
    }));
    room.status = "orderSelection";
    room.orderEndsAt = Date.now() + orderChoiceMs;
    broadcast(room, "orderSelectionStarted");
    const roundId = room.roundId;
    const timer = setTimeout(() => finishOrderSelection(room, roundId), orderChoiceMs);
    timer.unref?.();
  }

  function returnToLobby(room) {
    room.roundId += 1;
    room.status = "waiting";
    resetRoundState(room);
    broadcast(room);
  }

  function removeOrDisconnect(socket, explicit = false) {
    const membership = findMembership(socket);
    if (!membership) return;
    const { room, playerIndex } = membership;
    const player = room.players[playerIndex];
    socket.leave(room.id);

    if (explicit) {
      cancelDisconnectCleanup(player);
      removePlayerRecord(room, playerIndex);
    } else {
      player.connected = false;
      player.rematch = false;
      if (room.status === "playing" && playerIndex === room.currentPlayerIndex && !room.isProcessing) {
        room.selectedCards = [];
        advanceTurn(room);
      }
      if (!explicit) scheduleDisconnectCleanup(room, player);
    }

    if (activePlayers(room).length === 0) {
      if (!explicit) {
        broadcast(room);
        return;
      }
      closeEmptyRoom(room);
      return;
    }
    if (room.hostSocketId === player.id && room.status === "playing") {
      room.hostSocketId = activePlayers(room)[0].id;
    }
    if (room.status === "orderSelection" && activePlayers(room).every((candidate) =>
      room.orderCards.some((card) => card.chosenBy === candidate.id)
    )) {
      finishOrderSelection(room);
      return;
    }
    broadcast(room);
  }

  io.on("connection", (socket) => {
    socket.on("joinWatch", (payload = {}) => {
      if (findMembership(socket)) {
        return socket.emit("watchUnavailable", { message: "プレイヤー接続からは観戦モードへ移れません" });
      }
      const roomId = String(payload.roomId || "").trim();
      const room = rooms.get(roomId);
      if (socket.data.watchRoomId) {
        socket.leave(`watch:${socket.data.watchRoomId}`);
        socket.data.watchRoomId = null;
      }
      if (!/^\d{4}$/.test(roomId) || !room || !watchKeyMatches(room, payload.key)) {
        return socket.emit("watchUnavailable", { message: "観戦URLが無効です" });
      }
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
        watchKey: generateWatchKey(),
        hostSocketId: socket.id,
        players: [{
          id: socket.id,
          name,
          score: 0,
          connected: true,
          rematch: false,
          resumeToken: crypto.randomUUID()
        }],
        status: "waiting",
        cards: [],
        selectedCards: [],
        currentPlayerIndex: 0,
        isProcessing: false,
        revealAll: false,
        revealEndsAt: null,
        message: "",
        winners: [],
        orderCards: [],
        orderEndsAt: null,
        orderRevealed: false,
        turnOrder: [],
        roundId: 0
      };
      rooms.set(id, room);
      socket.join(id);
      socket.emit("roomCreated", { ...publicState(room), resumeToken: room.players[0].resumeToken });
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
      const player = {
        id: socket.id,
        name,
        score: 0,
        connected: true,
        rematch: false,
        resumeToken: crypto.randomUUID()
      };
      room.players.push(player);
      socket.join(room.id);
      socket.emit("roomJoined", { ...publicState(room), resumeToken: player.resumeToken });
      broadcast(room);
    });

    socket.on("resumeRoom", (payload = {}) => {
      if (socket.data.isWatcher || findMembership(socket)) return;
      const roomId = String(payload.roomId || "").trim();
      const resumeToken = String(payload.resumeToken || "");
      const room = rooms.get(roomId);
      const player = room?.players.find((candidate) => candidate.resumeToken === resumeToken);
      if (!room || !player) {
        return socket.emit("resumeUnavailable", { message: "前回のルームには復帰できませんでした" });
      }

      const previousSocketId = player.id;
      cancelDisconnectCleanup(player);
      if (room.hostSocketId === previousSocketId) room.hostSocketId = socket.id;
      player.id = socket.id;
      player.connected = true;
      room.orderCards.forEach((card) => {
        if (card.chosenBy === previousSocketId) card.chosenBy = socket.id;
      });
      room.turnOrder = room.turnOrder.map((id) => id === previousSocketId ? socket.id : id);
      socket.join(room.id);
      ensureCurrentConnected(room);
      socket.emit("roomResumed", { ...publicState(room), resumeToken: player.resumeToken });
      broadcast(room);
    });

    socket.on("startGame", () => {
      const membership = findMembership(socket);
      if (!membership) return emitError(socket, "ルームに参加していません");
      const { room } = membership;
      if (room.hostSocketId !== socket.id) return emitError(socket, "開始できるのはルーム作成者だけです");
      if (room.status !== "waiting") return emitError(socket, "ゲームはすでに開始されています");
      if (activePlayers(room).length < MIN_PLAYERS) return emitError(socket, "2人以上で開始できます");
      startOrderSelection(room);
    });

    socket.on("chooseOrderCard", (payload = {}) => {
      const membership = findMembership(socket);
      if (!membership) return emitError(socket, "ルームに参加していません");
      const { room, playerIndex } = membership;
      if (room.status !== "orderSelection" || !room.players[playerIndex].connected) return;
      if (room.orderCards.some((card) => card.chosenBy === socket.id)) return;
      const card = room.orderCards.find((candidate) => candidate.id === String(payload.cardId || ""));
      if (!card || card.chosenBy) return emitError(socket, "そのカードはすでに選ばれています");
      card.chosenBy = socket.id;
      broadcast(room, "orderCardChosen");
      if (activePlayers(room).every((player) =>
        room.orderCards.some((candidate) => candidate.chosenBy === player.id)
      )) finishOrderSelection(room);
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
          room.revealEndsAt = Date.now() + jokerDelay;
          broadcast(room, "jokerActivated");
          setTimeout(() => {
            if (!rooms.has(room.id) || room.roundId !== roundId || room.status !== "playing") return;
            room.revealAll = false;
            room.revealEndsAt = null;
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
      if (connected.length >= MIN_PLAYERS && connected.every((player) => player.rematch)) startOrderSelection(room);
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

module.exports = {
  CARD_DISPLAY_TIMINGS,
  CARD_LAYOUT,
  ORDER_GAME_TIMINGS,
  applyCardLayout,
  createApplication,
  createCardLayout,
  createDeck,
  shuffle
};
