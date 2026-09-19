package io.agentmux.wakeword

/**
 * WHAT: How eagerly the wake word answers, as three steps with a word each rather than a number.
 * WHY: Measured 2026-09-19, one fixed number cannot fit every voice and every room. One synthetic Swedish
 * voice never wakes Hey Jarvis at its threshold while the other always does; Hey Marvin has a burst on a
 * telephone caller that no run length refuses; and the clip set that priced the shipped rule is too easy to
 * price anything. The wearer is the only one who can hear his own room, and WAKE DEBUG shows him what each
 * step refuses.
 *
 * Three words, not a slider. A raw confidence threshold called "sensitivity" runs backwards to its own name,
 * higher meaning less sensitive, which is a trap rather than a control.
 *
 * Each step is a rule and an offset from the phrase's own measured threshold, which stays the anchor: the
 * numbers here move every phrase by the same amount rather than replacing what each phrase was measured at.
 * The words a wearer reads are declared in product-spec, not here; this file holds only what the loop does.
 */
enum class WakeSensitivity(
    val id: String,
    val thresholdOffset: Float,
    val detection: WakeDetectionPolicy,
) {
    STRICT("strict", STRICT_MARGIN, WakeDetectionPolicy(3)),
    NORMAL("normal", 0f, WakeDetectionPolicy()),
    EAGER("eager", -EAGER_MARGIN, WakeDetectionPolicy());

    init {
        // A step may refuse more than NORMAL or less, but none of them may go back to one chunk deciding:
        // that is the shape every false wake measured in an hour of radio had.
        require(detection.chunksOverThreshold >= 2) {
            "$name would let one chunk decide, which is what the rule of two exists to refuse"
        }
    }

    /** The phrase's own measured threshold, moved by this step and kept inside what a probability can be. */
    fun thresholdFor(phrase: WakePhrase): Float =
        (phrase.threshold + thresholdOffset).coerceIn(LOWEST_THRESHOLD, HIGHEST_THRESHOLD)

    companion object {
        /** A stored choice; null for a name this build does not offer, so the caller decides what that means. */
        fun byId(id: String?): WakeSensitivity? = entries.firstOrNull { it.id.equals(id, ignoreCase = true) }

        val offered: List<WakeSensitivity> = listOf(STRICT, NORMAL, EAGER)
    }
}

/**
 * STRICT's margin, which the measurement could not price. On the 68 minute corpus and the 48 clips, run of
 * three at +0.00, +0.05 and +0.10 give the same false wake rate on all three phrases, so every false wake
 * STRICT removes there is removed by the run of three alone; the margin's only measured effect is one lost
 * Alexa clip, 45 of 48 becoming 44. It is kept at the smaller of the two sizes because a higher threshold
 * can only ever refuse more, which is what a wearer asks for when he picks STRICT, and because an hour of
 * radio holds one false wake that nothing refuses, so it cannot price a lever against a louder room. The
 * device pass is what decides it. Numbers in docs/qa/2026-09-19-wake-sensitivity.
 */
private const val STRICT_MARGIN = 0.05f

/**
 * EAGER's margin, and the only step that gains anything measurable. At -0.10 Hey Jarvis wakes on 35 of the
 * 48 clips instead of 33 and on 7 of 12 Swedish instead of 6, recovering one clip of the voice it never
 * hears, with no false wake gained on any of the three phrases. At -0.05 it wakes on exactly what NORMAL
 * does, which would be a setting that does nothing. Nothing beyond -0.10 was measured, so nothing beyond it
 * is offered.
 */
private const val EAGER_MARGIN = 0.10f

/** A threshold is a probability, and neither end of one is a useful place to stand. */
private const val LOWEST_THRESHOLD = 0.05f
private const val HIGHEST_THRESHOLD = 0.95f
