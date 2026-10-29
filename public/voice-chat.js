"use strict";

window.ChopanVoice = {
  createController(socket) {
    const $ = (id) => document.getElementById(id);
    const peers = new Map();
    let roomId = null;
    let stream = null;
    let active = false;
    let generation = 0;
    let iceServers = [];
    let iceTransportPolicy = "all";
    let expiryTimer = null;
    let roster = [];
    let signalQueue = Promise.resolve();
    const status = (text) => { $("voiceStatus").textContent = text; };
    const hidden = (id, value) => $(id).classList.toggle("hidden", value);

    function render() {
      hidden("voicePanel", !roomId);
      hidden("voiceJoin", active);
      hidden("voiceMute", !active);
      hidden("voiceLeave", !active && !$("voiceJoin").disabled);
      const muted = Boolean(stream && !stream.getAudioTracks()[0]?.enabled);
      $("voiceMute").textContent = muted ? "マイクをオン" : "マイクをオフ";
      $("voiceMute").setAttribute("aria-pressed", String(muted));
      $("voicePeers").replaceChildren(...roster.map((peer) => {
        const chip = document.createElement("span");
        chip.textContent = `${peer.name}${peer.id === socket.id ? "（自分）" : ""}：${peer.muted ? "ミュート" : "通話参加中"}`;
        return chip;
      }));
    }

    function closePeer(id) {
      const peer = peers.get(id);
      if (!peer) return;
      peers.delete(id);
      peer.pc.close();
      peer.audio.srcObject = null;
      peer.audio.remove();
    }

    function leave(notify = true) {
      clearTimeout(expiryTimer);
      generation += 1;
      active = false;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      [...peers.keys()].forEach(closePeer);
      if (notify && socket.connected) socket.emit("voiceLeave");
      $("voiceJoin").disabled = false;
      hidden("voicePlay", true);
      status("通話には参加していません");
      render();
    }

    function createPeer(id) {
      if (peers.has(id)) return peers.get(id);
      const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.setAttribute("playsinline", "");
      $("voiceAudio").append(audio);
      const peer = { pc, audio, candidates: [] };
      peers.set(id, peer);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.onicecandidate = ({ candidate }) => {
        if (candidate && active && peers.get(id) === peer) socket.emit("voiceSignal", { to: id, signal: { type: "candidate", candidate: candidate.toJSON() } });
      };
      pc.ontrack = ({ streams, track }) => {
        audio.srcObject = streams[0] || new MediaStream([track]);
        audio.play().catch(() => hidden("voicePlay", false));
      };
      pc.onconnectionstatechange = () => {
        if (peers.get(id) !== peer) return;
        if (pc.connectionState === "failed") status("音声接続に失敗しました。通話を退出して再参加してください");
        if (pc.connectionState === "disconnected") status("相手の音声に再接続しています…");
        if (pc.connectionState === "connected") status("通話中です。ハウリングを防ぐにはイヤホンを使ってください");
      };
      return peer;
    }

    $("voiceJoin").addEventListener("click", async () => {
      if (!roomId || active || $("voiceJoin").disabled) return;
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
        status("この環境では通話できません。HTTPSまたはlocalhostで対応ブラウザを使ってください");
        return;
      }
      if (!socket.connected) { status("サーバーへの接続を待ってください"); return; }
      const attempt = ++generation;
      $("voiceJoin").disabled = true;
      status("マイクの許可を待っています…");
      render();
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        if (attempt !== generation) { acquired.getTracks().forEach((track) => track.stop()); return; }
        stream = acquired;
        stream.getAudioTracks().forEach((track) => { track.onended = () => { leave(); status("マイクが切断されました。再参加してください"); }; });
        status("通話に接続しています…");
        const result = await socket.timeout(8000).emitWithAck("voiceJoin", {});
        if (attempt !== generation) return;
        if (result.error) {
          leave();
          status(result.error);
          return;
        }
        active = true;
        iceServers = result.iceServers;
        iceTransportPolicy = result.iceTransportPolicy || "all";
        if (result.expiresAt) {
          expiryTimer = setTimeout(() => {
            if (attempt !== generation) return;
            leave();
            status("通話の有効期限になりました。もう一度参加してください");
          }, Math.max(0, result.expiresAt - Date.now() - 30_000));
        }
        $("voiceJoin").disabled = false;
        status(result.peers.length ? "音声を接続しています…" : "参加しました。相手の通話参加を待っています");
        render();
        for (const remote of result.peers) {
          if (attempt !== generation) return;
          const peer = createPeer(remote.id);
          const offer = await peer.pc.createOffer();
          if (attempt !== generation || peers.get(remote.id) !== peer) return;
          await peer.pc.setLocalDescription(offer);
          if (attempt !== generation) return;
          socket.emit("voiceSignal", { to: remote.id, signal: { type: "offer", sdp: peer.pc.localDescription.sdp } });
        }
      } catch (error) {
        if (attempt !== generation) return;
        leave();
        status(error.name === "NotAllowedError" ? "マイクの利用が許可されませんでした。ブラウザの設定を確認してください" : error.name === "NotFoundError" ? "マイクが見つかりません" : "通話を開始できませんでした。マイクと接続を確認して再参加してください");
      }
    });

    socket.on("voiceSignal", ({ from, signal }) => {
      const attempt = generation;
      signalQueue = signalQueue.then(async () => {
        if (!active || attempt !== generation) return;
        const peer = createPeer(from);
        if (signal.type === "candidate") {
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.candidate);
          else peer.candidates.push(signal.candidate);
          return;
        }
        await peer.pc.setRemoteDescription({ type: signal.type, sdp: signal.sdp });
        for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
        if (signal.type === "offer") {
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          if (attempt === generation && peers.get(from) === peer) socket.emit("voiceSignal", { to: from, signal: { type: "answer", sdp: peer.pc.localDescription.sdp } });
        }
      }).catch(() => { if (attempt === generation) status("音声接続に失敗しました。通話に再参加してください"); });
    });
    socket.on("voicePeers", (next) => {
      roster = next;
      for (const id of peers.keys()) if (!roster.some((peer) => peer.id === id)) closePeer(id);
      render();
    });
    socket.on("disconnect", () => { leave(false); roster = []; render(); status("接続が切れたため通話を終了しました。接続が戻ったら再参加してください"); });
    socket.on("voiceEnded", () => { leave(false); status("別の接続に切り替わったため通話を終了しました"); });
    $("voiceLeave").addEventListener("click", () => leave());
    $("voiceMute").addEventListener("click", () => {
      if (!stream) return;
      const muted = stream.getAudioTracks()[0].enabled;
      stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
      socket.emit("voiceMute", { muted });
      render();
    });
    $("voicePlay").addEventListener("click", async () => {
      const results = await Promise.allSettled([...peers.values()].map((peer) => peer.audio.play()));
      hidden("voicePlay", results.every((result) => result.status === "fulfilled"));
    });
    window.addEventListener("pagehide", () => leave());
    render();
    return { setRoom(next) { if (next === roomId) return; leave(); roomId = next; roster = []; render(); } };
  }
};
