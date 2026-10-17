/** WHAT: Dispatches one failed-voice notification through the durable message handler. WHY: Keeps transcription retries separate from the person's original message and its eventual transcript. */
export async function deliverVoiceFailure({ record, error, store, message, onMessage }) {
  const { attachmentId, path } = error.voiceFailure;
  let current = store.read(record.channelId, record.messageId) || record;
  if (current.status === "completed") return;
  const priorPane = Object.keys(current.effects || {}).find(key => key.startsWith("voice-failure-pane:"));
  const priorPost = Object.keys(current.effects || {}).find(key => key.startsWith("transcript-reply:voice-failure:"));
  const effect = priorPane || "voice-failure-pane";
  const cause = String(error.stderr || error.message).trim().slice(-800);
  const text = current.voiceFailureNotice || Object.values(current.voiceFailures || {})[0] || [
    "[Voice message received. Transcription unavailable; this is not a transcript.]",
    `Discord message: ${record.messageId}. Audio file: ${path}`,
    ...record.attachments.filter(a => a.contentType?.startsWith("audio/") && a.durablePath && a.durablePath !== path)
      .map(a => `Additional audio: ${a.durablePath}`),
    `Error: ${cause}`,
    "Check the audio file before replying. No transcript is available. Do not guess what the person said.",
    ...(record.text ? [`Original accompanying text: ${record.text}`] : []),
  ].join("\n");
  if (!current.voiceFailureNotice) {
    current = store.update(current, { voiceFailureNotice: text });
  }
  // A notice and the eventual transcript must never share either transport ID.
  if (store.beginEffect(current, effect)) {
    const outcome = await onMessage({ ...message,
      id: priorPane ? `${record.messageId}:voice-unavailable:${priorPane.slice("voice-failure-pane:".length)}`
        : `${record.messageId}:voice-unavailable`, text, attachments: [],
    });
    if (outcome?.delivered === false) throw new Error(outcome.reason || "voice failure notice not accepted");
    store.completeEffect(current, effect);
  }
  await message.sendTranscriptOnce(priorPost ? priorPost.slice("transcript-reply:".length) : "voice-failure",
    ["Rösten gick inte att skriva ut. Skriv meddelandet så länge."], { kind: "notice" });
}
