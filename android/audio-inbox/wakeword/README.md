# wakeword

Android-free, app-agnostic hands-free voice loop: an openWakeWord detector, a
Silero VAD speech probability, the end-of-question policy and a pure phase
reducer. A host app supplies PCM chunks, maps its own turn model to
`TurnProgress` and renders `WakeStatus`. No Link type is imported here, so the
module can move to a shared kit unchanged.

The JVM tests run the real models on synthetic edge-tts fixtures: one Swedish
question per offered phrase over brown noise, the weakest measured Swedish
Jarvis voice, and a Swedish sentence without any phrase. Kotlin scores match the
openWakeWord 0.4.0 Python reference (Hey Jarvis 0.9414 vs 0.9414, Hey Marvin
0.99994 vs 0.9999, Alexa 0.9990 vs 0.9986).

## Models

| File | Source | License |
| --- | --- | --- |
| `melspectrogram.onnx`, `embedding_model.onnx` | openWakeWord feature models (Google speech_embedding) | Apache-2.0 |
| `silero_vad.onnx` | Silero VAD v4 as bundled by openWakeWord 0.4.0 | MIT |
| `hey_jarvis_v0.1.onnx`, `hey_marvin_v0.1.onnx`, `alexa_v0.1.onnx` | openWakeWord 0.4.0 pretrained models | CC BY-NC-SA 4.0 (private use) |

Detection on 48 clips per phrase (eight accents, clean and brown noise) and
false wakes in 5.9 min of Swedish speech, measured 2026-09-14:

| Phrase | Swedish voices | All voices | False wakes | Threshold |
| --- | --- | --- | --- | --- |
| Hey Jarvis | 12/12 | 37/48 | 0 | 0.4 |
| Hey Marvin | 12/12 | 48/48 | 0 | 0.5 |
| Alexa | 12/12 | 45/48 | 0 | 0.5 |

Hey Mycroft ships with openWakeWord too but woke on 0 of 12 Swedish voices, so
it is not offered. Alexa also wakes Amazon devices nearby.
