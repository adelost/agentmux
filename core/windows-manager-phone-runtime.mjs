import { createAudioBytesTranscriber } from "./windows-manager-input.mjs";
import { createWindowsManagerPhoneServer } from "./windows-manager-phone.mjs";

/** WHAT: Builds one ordered manager-turn lane. WHY: Keeps phone and Discord turns from mutating shared state concurrently. */
export function createSerialTurnLane() {
  let lane = Promise.resolve();
  return (work) => {
    const next = lane.catch(() => {}).then(work);
    lane = next;
    return next;
  };
}

/** WHAT: Builds and starts phone I/O on one serialized manager turn. WHY: Keeps the Windows executable a thin transport loop below its existing cap. */
export async function startWindowsManagerPhone({
  config,
  rootDir,
  transcribePath,
  state,
  deps,
  history,
  serializeTurn,
  runManagerTurn,
  log,
} = {}) {
  if (!config.phoneHost) {
    log("phone endpoint disabled: phoneHost missing");
    return null;
  }
  const transcribeAudio = createAudioBytesTranscriber({
    config,
    rootDir,
    scriptPath: transcribePath,
  });
  const phone = createWindowsManagerPhoneServer({
    host: config.phoneHost,
    port: Number(config.phonePort) || 8081,
    serverId: config.phoneServerId || "abyss-windows",
    state,
    saveState: deps.saveState,
    transcribeAudio,
    onError: (error) => log(`phone endpoint failed after startup: ${error?.message || error}`),
    processTurn: ({ text, turnId }) => serializeTurn(async () => {
      await deps.sendMessage(`📱 ${text}`);
      const result = await runManagerTurn({
        userText: text,
        messageId: `phone:${turnId}`,
        state,
        history,
        deps,
      });
      await deps.sendMessage(result.answer);
      history.push({ role: "user", content: text }, { role: "assistant", content: result.answer });
      if (history.length > 10) history.splice(0, history.length - 10);
      return result;
    }),
  });
  let address;
  try {
    address = await phone.start();
  } catch (error) {
    // The independent Discord control plane must survive a phone-port fault.
    log(`phone endpoint unavailable: ${error?.message || error}`);
    return null;
  }
  log(`phone endpoint listening ${address.address}:${address.port}`);
  return phone;
}
