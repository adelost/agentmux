# Link: recent conversations on the watch

Bounded follow-up to the conversation review; no new history service or layout
engine. Phone and Wear consume the same recipient-scoped, retained 50-turn
window. Wear currently holds that window in its controller, not a disk archive;
this slice must not promise server history or persistence that does not exist.

Design: retain the calm watch home and unchanged voice gesture. HISTORY opens
recent messages, newest first. A row identifies the user's message and local
time; selecting its stable turn ID opens the complete exchange. New replies
must not change the exchange being read. Back returns to the same list. The
existing shared prose/action atoms provide text and audio on both hosts.
Wear offers Play/Stop, never fake pause/resume. Only the existing player owns
audio. Phone retains its real anchored pause/resume and attachment actions.

Acceptance
- [x] Older messages are reachable, including messages without replies.
- [x] Selected recipient ID filters history exactly; another window's turns
      are never selected by a label or array position.
- [x] Full user text and reply remain readable with scroll/crown and visible Back.
- [x] Empty history and long content are proven natively; an evicted ID uses an
      explicit unavailable message (source checked, not a native eviction probe).
- [x] Existing single-player command routing is used for any selected turn.
- [x] Hold-to-record/release-to-send and stationary press target are unchanged.
- [x] Shared small presentation tests + compile; bounded named Phone/Wear proof
      with local fixtures only, no sends to a real person/agent.
- [ ] Fresh-master merge, exact signed publication/verification, final receipts
      and actual inspected screenshots; no bridge/host install or restart.

No CircleKit source edits. Any dependency adoption must be an already public
version agreed at the short resource handover, not a parallel icon/palette fork.

Picture acceptance (before inspection): the round history must identify the
older prompt and its time, with reachable visible Back. The reader must expose
the actual final sentence of the long reply after named scroll, not truncate
the stored text. Phone must show the same older prompt and full prose in its
existing conversation list; the selected recipient and PTT anchor stay visible.
Empty recipient must show no messages from the previous recipient. All data in
these pictures is explicitly local preview data, not a real conversation.

Proof (2026-09-05): focused 11 JVM tests and both release compiles pass.
The same named instrumentation driver passed on pixel35 and wear34. It opens
an older message, scrolls to its actual final sentence, returns to history,
opens a reply-less message and changes recipient to verify empty history.
The first Phone attempt exposed a driver-only scroll request on a fixed header;
the corrected driver clicks that named header and passes. No production tap
workaround. The existing graph integration additionally proves that a newly
arriving turn does not redirect an older turn's playback command.

Inspected pictures: /tmp/link-history-wear-final.png (older prompt, timestamp,
visible Back), /tmp/link-history-wear-end.png (actual last sentence), and
/tmp/link-history-phone.png (same prose, recipient, stationary composer/PTT).
Empty-recipient images were also inspected. The history image is scrolled,
so the preceding row is intentionally partly outside the viewport. No claim
that all messages or a long reply fit simultaneously. Named scroll is proven;
physical crown hardware and actual TTS audio are not part of this run.

Remaining product limit: Wear's existing 50-turn window is process-memory
history, not a restart-persistent archive. Phone keeps its existing persistence.
The limit is global, not 50 per recipient. This is Link conversation history,
not a Discord channel archive. Capacity/late-reply regression uses the real
reducer: after 50 replacements the evicted ID is absent, and a late reply does
not resurrect it or mutate another message. Full Discord import is not added.
