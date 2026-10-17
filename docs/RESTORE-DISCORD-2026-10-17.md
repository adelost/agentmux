# Discord output restored, agentmux 1.25.237 and 1.25.238

Mattias explicitly asked to see the information hidden or shortened by
9d37147 again. These releases restore its original visible output. The
1.25.236 quota overview and AMUX_TOOL_LINES_CHANNELS setting remain intact.

Every output-changing hunk in 9d37147 was compared with its parent:

| Original change | Restored output |
|---|---|
| attachments.mjs | 1.25.237 restores Transcript headings, complete bounded chunks, ordinary STT note and Whisper fallback note. Original tests and durable retry tests restored. |
| channels/jsonl-watcher.mjs | Model, effort, context percent and available token count after replies; timestamped Context compacted announcements; original caption for file-only messages. |
| channels/native-runtime-watcher.mjs | Native observed model, effort, context percent and available token count after replies. |
| channels/auto-compact.mjs | Full compact-failed, compact-held, postponed and context/grace warnings, including their reasons and original retry behavior. |
| cli/account-switch-compact.mjs | The account-switch compact command mirror and verification of its send receipt. |
| cli/nightly-compact.mjs | The nightly compact command mirror and verification of its send receipt. |
| cli/tmux.mjs | Complete pane-to-pane message, source prefix, sender delivery receipt, unverified/not-delivered outcome and both composer-control receipts with command/control identity. |
| core/delivery-notice-copy.mjs | Waiting reason, elapsed wait, automatic-delivery explanation, confirmation time and waited duration; original unknown reason instead of a generic replacement. Other delivery outcomes unchanged. |
| core/inbound-voice-failure.mjs | Transcription unavailable heading and the actual original failure text. |
| core/unmapped-channel.mjs | Original explanation that no agent received the message and the alternative channel action. |
| cli/send-notify.mjs, core/user-notification-copy.mjs | Original notification title, level and body, plus the original optional file caption. |
| core/quota-format.mjs | Original per-pane stopped-on-quota Discord and push notices, known reset, automatic recovery or nudge and pane-log command. The separate 1.25.236 overview stays byte-identical. |

Retained infrastructure from 9d37147: Discord edit/delete ownership checks,
mirror retry identities, transcript nonce and journal guards, the optional
work-row implementation, quota notice delivery and the current quota overview.
The tool-line setting remains enabled everywhere in the running bridge.
No queue, compact, session or at-most-once fence is weakened.

The old footer text is extracted into core/context-footer.mjs; the original
watcher integration expectations exercise both paths. Shared compact-notice
transport removes duplication while keeping its original output. Existing
file caps are not raised.

Verification receipts are outside Git under
/home/adelost/lsrc/.artifacts/restore-transcripts-7-20261017/.
1.25.237: eight original symptom failures before restoration, 36 focused tests,
privacy guard and strict changed-source lint pass. A natural real voice note
produced its exact transcript in Discord, verified with a GET, without a
manual post or another transcription call.
1.25.238: 17 original notice/mirror failures and four original watcher failures
before restoration. Focused and installed/live evidence accompanies release.
