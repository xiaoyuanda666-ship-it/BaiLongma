function normalize(value) {
  return String(value || "").trim();
}

function turnKey(data = {}) {
  return normalize(data.turn_id || data.turnId);
}

function messageKey(data = {}) {
  const id = normalize(data.conversation_id || data.conversationId);
  return id ? `message:${id}` : `turn:${turnKey(data)}`;
}

export function targetClientId(data = {}) {
  return normalize(
    data.target_client_id
      || data.targetClientId
      || data.reply_client_id
      || data.replyClientId,
  );
}

export function createVoiceReplyCoordinator(uiClientId) {
  const clientId = normalize(uiClientId);
  const turns = new Map();
  const handledMessages = new Set();

  function ensureTurn(data = {}) {
    const key = turnKey(data) || `legacy:${targetClientId(data) || "broadcast"}`;
    let turn = turns.get(key);
    if (!turn) {
      turn = {
        id: key,
        targetClientId: targetClientId(data),
        targetMatched: false,
        wantsSpeech: false,
        streamingSelected: false,
        streamingFailed: false,
        audioStarted: false,
        spokenPrefix: "",
        finalText: "",
        finalData: null,
        fallbackStarted: false,
      };
      turns.set(key, turn);
    }
    const target = targetClientId(data);
    if (target) turn.targetClientId = target;
    // Voice replies are fail-closed: a missing target must never become a
    // broadcast playback permission on every open desktop/iPad client.
    turn.targetMatched = Boolean(turn.targetClientId && turn.targetClientId === clientId);
    if (data.speak === true) turn.wantsSpeech = true;
    return turn;
  }

  function streamStart(data = {}, { streamingEnabled = true } = {}) {
    const turn = ensureTurn(data);
    const eligible = data.speak === true && turn.targetMatched;
    turn.wantsSpeech = turn.wantsSpeech || data.speak === true;
    turn.streamingSelected = Boolean(eligible && streamingEnabled);
    return {
      turn,
      eligible,
      startStreaming: turn.streamingSelected,
      reason: !data.speak
        ? "speak-disabled"
        : (!turn.targetMatched ? "target-mismatch" : (streamingEnabled ? "streaming" : "whole-reply")),
    };
  }

  function audioStarted(data = {}) {
    const turn = ensureTurn(data);
    turn.audioStarted = true;
    return turn;
  }

  function streamFailed(data = {}, { spokenPrefix = "", reason = "stream-failed" } = {}) {
    const turn = ensureTurn(data);
    turn.streamingFailed = true;
    turn.spokenPrefix = normalize(spokenPrefix);
    if (!turn.finalText || turn.fallbackStarted || !turn.targetMatched || !turn.wantsSpeech) {
      return { action: "none", turn, reason };
    }
    return fallbackDecision(turn, reason);
  }

  function fallbackDecision(turn, reason) {
    let text = turn.finalText;
    if (turn.spokenPrefix && text.startsWith(turn.spokenPrefix)) {
      text = text.slice(turn.spokenPrefix.length).trim();
    } else if (turn.spokenPrefix) {
      // Stream sentences and the authoritative message may differ only by
      // markdown stripping/whitespace. Prefer skipping the same character
      // budget over replaying the entire already-heard prefix.
      text = text.slice(Math.min(turn.spokenPrefix.length, text.length)).trim();
    }
    if (!text) return { action: "none", turn, reason: "nothing-unspoken" };
    return {
      action: turn.spokenPrefix ? "play_remaining" : "play_full",
      text,
      turn,
      reason,
      playbackKey: messageKey(turn.finalData || { turn_id: turn.id }),
    };
  }

  function finalMessage(data = {}, text = "") {
    const key = messageKey(data);
    if (key && handledMessages.has(key)) {
      return { action: "none", reason: "duplicate-message", playbackKey: key };
    }
    if (key) handledMessages.add(key);

    const turn = ensureTurn(data);
    turn.finalData = data;
    turn.finalText = normalize(text);
    turn.wantsSpeech = turn.wantsSpeech || data.speak === true;

    if (!turn.wantsSpeech) return { action: "none", turn, reason: "speak-disabled", playbackKey: key };
    if (!turn.targetMatched) return { action: "none", turn, reason: "target-mismatch", playbackKey: key };
    if (!turn.finalText) return { action: "none", turn, reason: "empty-text", playbackKey: key };
    if (turn.streamingSelected && !turn.streamingFailed) {
      return { action: "finalize_stream", turn, reason: "streaming-active", playbackKey: key };
    }
    return fallbackDecision(turn, turn.streamingFailed ? "stream-failed" : "stream-not-started");
  }

  function markFallbackStarted(turn) {
    if (!turn || turn.fallbackStarted) return false;
    turn.fallbackStarted = true;
    return true;
  }

  function resetTurn(data = {}) {
    const key = turnKey(data);
    if (key) turns.delete(key);
  }

  return {
    clientId,
    streamStart,
    audioStarted,
    streamFailed,
    finalMessage,
    markFallbackStarted,
    resetTurn,
    getTurn: data => ensureTurn(data),
  };
}
