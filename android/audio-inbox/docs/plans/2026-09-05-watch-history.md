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

Mattias's follow-ups before publication (same 2026-09-05 delivery):
- [x] Bound text as well as turn count. Shared policy: 12,000 UTF-16 characters
      per message/reply including explicit local-shortening marker, 256,000
      total retained text characters; evict oldest whole exchanges first.
      Preserve the existing 4,000-character composer cap. Public HTTP already
      rejects responses over 128 KiB; do not invent another transport layer.
- [x] Recording starts immediately, no 200 ms arming sweep. Release before
      500 ms discards rather than sends; shared monotonic timing, same gesture.
- [x] Verify empty/whitespace SEND is disabled AND visibly muted. No fake new
      validation if the existing atom already rejects it.
- [x] Inspect restart/audio: retain readable text. The old implementation
      re-fetched TTS on every manual replay. The new disposable cache survives
      service/process-owner recreation: exact server+text key, 24-hour validity,
      10 files and 32 MiB including reserved pending cache writes. Playback owns
      a separate temporary copy; no new audio engine. A local-only native test
      closes the HTTP server, restarts the real service, reloads retained text
      and reaches PLAYING in 162 ms with only one HTTP request in total. This
      proves offline cached replay, not a universally fixed startup latency.
- [x] Keep standard conversation concise: message/reply, genuine pending/error
      status, no tool-call/debug transcript in the main feed. Auto-read remains
      the existing option and single player, not a driving mode or wake-word feature.
- [x] Drag outside the recording control cancels without sending. The same
      shared lifecycle handles normal release, cancel and unmount; visible
      SLIDE AWAY TO CANCEL. Native Phone tests exercise all four paths and
      the existing single-player replacement/pause/stop behavior (6/6).
- [x] Prefer distinct READ REPLIES and ANNOUNCEMENTS over two ambiguous audio
      toggles. One small consumed descriptor list, same settings atom/keys.
      Voice keeps a stable location; do not swap it into a Send button during a
      press. Tool calls and internal logs stay out of the conversation feed.

Text budget is not a claim about total JVM heap. Oversized old serialized
history above 2,000,000 characters is rejected before JSON parsing and cleared
with an explicit recovery notice, not duplicated into another enormous cache.
Known transcription-empty receipts get short human-readable copy while the
original detail remains in stored state. First-time TTS still needs the server;
no speculative paid speech prefetch, wake word or driving interaction is added.

Later native/source proof supersedes the initial PTT-unchanged line above:
the hold/release ownership is preserved, while startup timing and accidental
short-press policy were deliberately changed by Mattias's subsequent order.

Final integration: public CircleKit 0.3.63 (source 97e5998db7e3d36f38b59e8e46095453c0d76e6c)
fixes disabled icon tint and disabled accessibility semantics. Anonymous RingKit
and DesignKit AAR checksums match the publisher's exact final receipt. No local
staging artifact or CircleKit source fork is consumed. This pin does not claim
Link category-color adoption; those product palette declarations remain separate.

The first final settings lap failed honestly: removing RingActionCueHost also
removed explicit information dialogs. Restored the existing host, not a second
information renderer. The published atom already suppresses IMMEDIATE action
confirmation; the recording change is holdMs=0, not removal of help. The actual
pointer test now also rejects a progress overlay during recording. Final Phone
6/6 (history/empty Send, settings/info/back, four pointer lifecycles) and Wear
2/2 (history/full reply/empty recipient, real recorder) pass with the public pin.

Inspected final images: /tmp/link-final-phone-conversation.png shows a muted
empty SEND even with the keyboard open; /tmp/link-final-phone-settings.png has
distinct READ REPLIES/ANNOUNCEMENTS and aligned info atoms; explicit info is
readable and closes. /tmp/link-final-wear-recording.png has an unclipped waveform,
stable press target, release/cancel copy and visible Back. The final Wear history
and full-reply-end pictures meet the criteria above. These are native debug
fixtures, not real agent messages or signed-release interaction evidence.

Owner assessment: 9/10 for the demonstrated conversation/recording/history flows
on these Phone/Wear sizes, not a claim about every device or production service.
Known limits: Wear history is not restart-persistent, cold speech needs HTTP,
and the existing serial download owner may still wait for an in-flight request
when switching during a cold fetch. No Discord import, wake word, new audio
engine, or native color lookup was introduced.
