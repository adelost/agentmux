package io.agentmux.linkcore

/**
 * WHAT: Describes a strictly parsed three-part semantic application version.
 * WHY: Keeps update ordering from relying on ambiguous string comparison.
 */
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

/**
 * WHAT: Checks that a release's numeric code and semantic name both advance.
 * WHY: Keeps rollback or mislabeled release manifests from reaching installation.
 */
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
