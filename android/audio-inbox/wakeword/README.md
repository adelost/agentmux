# wakeword

Android-free, app-agnostic hands-free voice loop: an openWakeWord detector, a
Silero VAD speech probability, the end-of-question policy and a pure phase
reducer. A host app supplies PCM chunks, maps its own turn model to
`TurnProgress` and renders `WakeStatus`. No Link type is imported here, so the
module can move to a shared kit unchanged.

The JVM tests run the real models on two synthetic fixtures (edge-tts voices):
an English "Computer, what time is it" question and a Swedish sentence without
the word. Kotlin scores match the openWakeWord 0.4.0 Python reference
(0.9988 vs 0.999 and 0.0010 vs 0.001).

## Models

| File | Source | License |
| --- | --- | --- |
| `melspectrogram.onnx`, `embedding_model.onnx` | openWakeWord feature models (Google speech_embedding) | Apache-2.0 |
| `silero_vad.onnx` | Silero VAD v4 as bundled by openWakeWord 0.4.0 | MIT |
| `computer_v1.onnx` | fwartner/home-assistant-wakewords-collection `en/computer`, commit 1c6d6a8 | MIT |

`computer_v1` reacts to "computer" and "hey computer". Its published training
report lists recall 0.57 and 4.7 false activations per hour on the trainer's
held-out set; measure on the real device before tuning the threshold.
