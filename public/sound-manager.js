(function () {
  "use strict";

  const SOUND_PATHS = {
    cardFlipped: "/sounds/flip.mp3",
    pairMatched: "/sounds/match.mp3",
    pairFailed: "/sounds/miss.mp3",
    jokerActivated: "/sounds/hgsound.mp3",
    gameEnded: "/sounds/finish.mp3"
  };
  const SYNTH_PROFILES = {
    cardFlipped: [[720, 0.045, "triangle", 0.045], [980, 0.04, "sine", 0.025]],
    pairMatched: [[660, 0.08, "sine", 0.055], [880, 0.11, "sine", 0.05]],
    pairFailed: [[240, 0.1, "triangle", 0.05], [180, 0.12, "sine", 0.035]],
    jokerActivated: [[520, 0.09, "triangle", 0.055], [780, 0.11, "sine", 0.055], [1100, 0.16, "sine", 0.045]],
    gameEnded: [[523, 0.12, "sine", 0.05], [659, 0.14, "sine", 0.05], [784, 0.22, "sine", 0.055]]
  };

  function safeRead(key, defaults) {
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem(key) || "{}") };
    } catch {
      return { ...defaults };
    }
  }

  function createSoundController({ mode = "player", ids = {} } = {}) {
    const storageKey = `chopan-sound-settings-${mode}`;
    const settings = safeRead(storageKey, {
      effects: true,
      speech: mode === "player",
      volume: 0.55
    });
    const audioFiles = {};
    const unavailableFiles = new Set();
    let unlocked = false;
    let audioContext = null;
    let lastCountdownId = null;
    let lastCountdownSecond = null;

    Object.entries(SOUND_PATHS).forEach(([eventName, path]) => {
      if (typeof Audio !== "function") return;
      try {
        const audio = new Audio(path);
        audio.preload = "auto";
        audio.addEventListener?.("error", () => unavailableFiles.add(eventName), { once: true });
        audioFiles[eventName] = audio;
      } catch { /* Audio未対応環境ではWeb Audioの代替音を使う */ }
    });

    function save() {
      try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* 設定保存不可でもゲームは続行 */ }
    }

    function ensureContext() {
      if (audioContext) return audioContext;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      try { audioContext = new AudioContextClass(); } catch { return null; }
      return audioContext;
    }

    function unlock() {
      unlocked = true;
      const context = ensureContext();
      if (context?.state === "suspended") context.resume().catch(() => {});
    }

    document.addEventListener?.("pointerdown", unlock, { once: true, passive: true });
    document.addEventListener?.("keydown", unlock, { once: true });

    function synthesize(eventName) {
      const context = ensureContext();
      if (!context || context.state === "suspended") return;
      let offset = 0;
      for (const [frequency, duration, type, gainValue] of SYNTH_PROFILES[eventName] || []) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + offset;
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainValue * settings.volume), start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.01);
        offset += duration * 0.58;
      }
    }

    function play(eventName) {
      if (!settings.effects || !unlocked || !SOUND_PATHS[eventName]) return;
      const audio = audioFiles[eventName];
      if (!audio || unavailableFiles.has(eventName)) {
        synthesize(eventName);
        return;
      }
      try {
        audio.volume = settings.volume;
        audio.currentTime = 0;
        const playback = audio.play();
        if (playback?.catch) playback.catch(() => synthesize(eventName));
      } catch {
        synthesize(eventName);
      }
    }

    function playCountdownTick(seconds, countdownId) {
      if (!settings.effects || !unlocked || !Number.isInteger(seconds) || seconds < 0) return;
      const nextCountdownId = String(countdownId || "countdown");
      if (lastCountdownId === nextCountdownId && lastCountdownSecond === seconds) return;
      lastCountdownId = nextCountdownId;
      lastCountdownSecond = seconds;

      const context = ensureContext();
      if (!context || context.state === "suspended") return;
      try {
        const urgent = seconds <= 3;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime;
        const duration = seconds === 0 ? 0.22 : urgent ? 0.075 : 0.045;
        oscillator.type = seconds === 0 ? "sawtooth" : "square";
        oscillator.frequency.setValueAtTime(seconds === 0 ? 1320 : urgent ? 1050 : 760, start);
        if (seconds === 0) oscillator.frequency.exponentialRampToValueAtTime(520, start + duration);
        gain.gain.setValueAtTime(Math.max(0.0001, 0.045 * settings.volume), start);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.01);
      } catch { /* カウント音が使えなくてもゲームは続行 */ }
    }

    function speak(text, { rate = 1.3125, pitch = 1.08, setting = "speech" } = {}) {
      if (!settings[setting] || !unlocked || !text || !("speechSynthesis" in window)) return;
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "ja-JP";
        utterance.rate = rate;
        utterance.pitch = pitch;
        utterance.volume = settings.volume;
        const japaneseVoice = window.speechSynthesis.getVoices().find((voice) => voice.lang?.toLowerCase().startsWith("ja"));
        if (japaneseVoice) utterance.voice = japaneseVoice;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
      } catch { /* 読み上げ不可でもゲームは続行 */ }
    }

    function handleGameEvent(eventName, nextState, previousState, { selfId } = {}) {
      play(eventName);
      if (!nextState || nextState.status !== "playing") return;
      const current = nextState.players?.find((player) => player.id === nextState.currentPlayerId);
      if (!current) return;

      if (mode === "player") {
        const becameMyTurn = current.id === selfId && previousState?.currentPlayerId !== selfId;
        const roundStartedForMe = eventName === "gameStarted" && current.id === selfId && previousState?.status !== "playing";
        if ((eventName === "turnChanged" && becameMyTurn) || roundStartedForMe) speak(`${current.name}さんのばんだよ`);
        return;
      }

      const turnChanged = previousState?.currentPlayerId !== nextState.currentPlayerId;
      const roundStarted = eventName === "gameStarted" && previousState?.status !== "playing";
      if ((eventName === "turnChanged" && turnChanged) || roundStarted) speak(`${current.name}さんのばんだよ`);
    }

    function bindControls() {
      const effectsInput = document.getElementById(ids.effects || "soundEffectsEnabled");
      const speechInput = document.getElementById(ids.speech || "turnSpeechEnabled");
      const volumeInput = document.getElementById(ids.volume || "soundVolume");
      const volumeOutput = document.getElementById(ids.volumeOutput || "soundVolumeValue");

      if (effectsInput) {
        effectsInput.checked = settings.effects;
        effectsInput.addEventListener("change", () => { settings.effects = effectsInput.checked; save(); });
      }
      if (speechInput) {
        speechInput.checked = settings.speech;
        speechInput.addEventListener("change", () => {
          settings.speech = speechInput.checked;
          if (!settings.speech) window.speechSynthesis?.cancel?.();
          save();
        });
      }
      if (volumeInput) {
        volumeInput.value = String(Math.round(settings.volume * 100));
        const updateVolume = () => {
          settings.volume = Math.min(1, Math.max(0, Number(volumeInput.value) / 100));
          if (volumeOutput) volumeOutput.textContent = `${Math.round(settings.volume * 100)}%`;
          save();
        };
        volumeInput.addEventListener("input", updateVolume);
        if (volumeOutput) volumeOutput.textContent = `${Math.round(settings.volume * 100)}%`;
      }
    }

    bindControls();
    return { handleGameEvent, play, playCountdownTick, settings, unlock };
  }

  window.ChopanAudio = { createSoundController, SOUND_PATHS };
}());
