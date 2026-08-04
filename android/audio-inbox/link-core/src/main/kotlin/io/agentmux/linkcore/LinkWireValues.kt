package io.agentmux.linkcore

/** Product route class of a conversation target; transport bindings map into it. */
enum class LinkTargetKind {
    AGENT,
    WINDOWS,
    PUBLIC,
}

/** The two durable user preferences behind the typed preferences port. */
enum class LinkPreferenceKey {
    HANDS_FREE,
    SPEAK_REPLIES,
}

/** User operations accepted by the typed updates port. */
enum class LinkUpdateOperation {
    CHECK,
    RETRY,
    INSTALL,
}

/** Product phase of the release/update flow; ReleaseKit state maps into it. */
enum class LinkUpdatePhase {
    IDLE,
    CHECKING,
    UP_TO_DATE,
    UNAVAILABLE,
    AVAILABLE,
    DOWNLOADING,
    READY_TO_INSTALL,
    INSTALLING,
    INSTALL_FAILED,
    FAILED,
}

/** State-repository recovery truth surfaced by the typed recovery port. */
enum class LinkRecoveryPhase {
    CLEAN,
    QUARANTINED,
}
