package io.agentmux.linkcore

data class SemanticVersion(val major: Int, val minor: Int, val patch: Int) :
    Comparable<SemanticVersion> {
    override fun compareTo(other: SemanticVersion): Int =
        compareValuesBy(this, other, SemanticVersion::major, SemanticVersion::minor, SemanticVersion::patch)

    companion object {
        private val pattern = Regex("""^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$""")

        fun parse(raw: String): SemanticVersion? {
            val match = pattern.matchEntire(raw) ?: return null
            return runCatching {
                SemanticVersion(
                    match.groupValues[1].toInt(),
                    match.groupValues[2].toInt(),
                    match.groupValues[3].toInt(),
                )
            }.getOrNull()
        }
    }
}

object UpdatePolicy {
    fun isStrictUpgrade(
        currentCode: Int,
        currentName: String,
        remoteCode: Int,
        remoteName: String,
    ): Boolean {
        val current = SemanticVersion.parse(currentName) ?: return false
        val remote = SemanticVersion.parse(remoteName) ?: return false
        return remoteCode > currentCode && remote > current
    }
}
