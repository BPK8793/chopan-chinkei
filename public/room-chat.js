"use strict";

window.ChopanChat = {
  createController(socket) {
    const $ = (id) => document.getElementById(id);
    let roomId = null;
    let sending = false;
    const show = (text) => {
      $("chatLatest").textContent = text;
      $("chatLatest").title = text;
    };
    const update = () => {
      $("chatInput").disabled = !roomId || !socket.connected;
      $("chatSend").disabled = !roomId || !socket.connected || sending;
    };
    $("chatForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = $("chatInput").value.trim();
      if (!roomId || !socket.connected || sending || !text) return;
      const targetRoom = roomId;
      sending = true;
      update();
      try {
        const result = await socket.timeout(5000).emitWithAck("chatSend", { text });
        if (roomId !== targetRoom) return;
        if (result.error) show(result.error);
        else if ($("chatInput").value.trim() === text) $("chatInput").value = "";
      } catch {
        if (roomId === targetRoom) show("送信できませんでした。接続を確認してください");
      } finally {
        sending = false;
        update();
      }
    });
    socket.on("chatMessage", (message) => {
      if (roomId && message.roomId === roomId) show(`${message.name}：${message.text}`);
    });
    socket.on("disconnect", update);
    socket.on("connect", update);
    return {
      setRoom(next) {
        if (next !== roomId) {
          roomId = next;
          $("chatInput").value = "";
          show("音声が届かないときも、ここで連絡できます");
        }
        $("roomChat").classList.toggle("hidden", !roomId);
        update();
      }
    };
  }
};
