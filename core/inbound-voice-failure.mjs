/** WHAT: Dispatches one failed-voice notification through the durable message handler. WHY: Keeps transcription retries separate from the person's original message and its eventual transcript. */
export async function deliverVoiceFailure({ record, error, store, message, onMessage }) {
  const { attachmentId, path } = error.voiceFailure;
  const effect = `voice-failure-pane:${attachmentId}`;
  let current = store.read(record.channelId, record.messageId) || record;
  const cause = String(error.stderr || error.message).trim().slice(-800);
  const text = current.voiceFailures?.[attachmentId] || [
    "[Voice message received. Transcription unavailable; this is not a transcript.]",
    `Discord message: ${record.messageId}. Audio file: ${path}`,
    `Error: ${cause}`,
    "AMUX will retry transcription and deliver it separately. Do not guess what the person said.",
    ...(record.text ? [`Original accompanying text: ${record.text}`] : []),
  ].join("\n");
  if (!current.voiceFailures?.[attachmentId]) {
    current = store.update(current, { voiceFailures: { ...current.voiceFailures, [attachmentId]: text } });
  }
  // A notice and the eventual transcript must never share either transport ID.
  if (store.beginEffect(current, effect)) {
    const outcome = await onMessage({ ...message,
      id: `${record.messageId}:voice-unavailable:${attachmentId}`, text, attachments: [],
    });
    if (outcome?.delivered === false) throw new Error(outcome.reason || "voice failure notice not accepted");
    store.completeEffect(current, effect);
  }
  await message.sendTranscriptOnce(`voice-failure:${attachmentId}`,
    [`**Transcription unavailable**\n${text}`], { kind: "notice" });
}
