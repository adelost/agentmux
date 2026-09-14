package io.agentmux.wakeword

/** Replies up to this many characters are read in full; longer ones are summarized. */
const val FULL_READ_CHARS = 600

/** What to say aloud for one written reply, and whether the rest stays on screen. */
data class SpokenReply(val text: String, val shortened: Boolean)

private val FENCED_CODE = Regex("```[\\s\\S]*?```")
private val MARKDOWN_LINK = Regex("\\[([^\\]]+)]\\([^)]*\\)")
private val BARE_URL = Regex("https?://\\S+")
private val EMPHASIS = Regex("[*_`~|>#]+")
private val BULLET = Regex("^\\s*(?:[-*•]|\\d+[.)])\\s+")
private val LABEL = Regex("^([A-Z]{3,12}):\\s*")
private val SENTENCE_END = Regex("[.!?](?=\\s|$)")

/**
 * WHAT: Turns an agent's written reply into speech: no markup, no links or code,
 * and for long replies only the summary line or first paragraph.
 * WHY: A hands-free listener needs the answer, not a 1500-character technical report read out loud.
 */
fun spokenReply(reply: String, moreOnScreen: String, fullReadChars: Int = FULL_READ_CHARS): SpokenReply {
    val lines = reply.replace(FENCED_CODE, "\n")
        .lines()
        .map { it.replace(MARKDOWN_LINK, "$1").replace(BARE_URL, "").replace(BULLET, "") }
        .map { it.replace(EMPHASIS, "").trim() }
    val summary = lines.firstNotNullOfOrNull { line -> LABEL.find(line)?.takeIf { it.groupValues[1] == "SUMMARY" }?.let { line.substring(it.range.last + 1).trim() } }
    val sentences = lines.map { it.replace(LABEL, "") }.filter { it.isNotBlank() }.map(::withFullStop)
    val whole = sentences.joinToString(" ")
    if (whole.length <= fullReadChars) return SpokenReply(whole, shortened = false)
    val lead = summary?.takeIf { it.isNotBlank() }?.let(::withFullStop) ?: firstParagraph(lines)
    return SpokenReply("${clipAtSentence(lead, fullReadChars)} $moreOnScreen", shortened = true)
}

private fun withFullStop(line: String): String = if (line.last() in ".!?:;") line else "$line."

private fun firstParagraph(lines: List<String>): String =
    lines.dropWhile { it.isBlank() }.takeWhile { it.isNotBlank() }.map { it.replace(LABEL, "") }.joinToString(" ", transform = ::withFullStop)

private fun clipAtSentence(text: String, limit: Int): String {
    if (text.length <= limit) return text
    val cut = SENTENCE_END.findAll(text).map { it.range.last + 1 }.lastOrNull { it <= limit }
    return if (cut != null) text.substring(0, cut) else text.substring(0, limit).substringBeforeLast(' ') + "…"
}
