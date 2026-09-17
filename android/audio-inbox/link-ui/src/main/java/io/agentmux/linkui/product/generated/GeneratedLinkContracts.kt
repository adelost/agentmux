// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM product-spec/src/contracts.ts
// Product declaration SHA-256: 994066c4527b0e5f37f24e090950bb146092d4fb6b5b202623aacfa154eda2ed
package io.agentmux.linkui.product.generated

/** Contract `link.captured-turn`. */
data class GeneratedLinkCapturedTurn(
    val turnId: String,
    val targetId: String,
    val payloadRef: String,
    val idempotencyKey: String,
    val createdAtMs: Long,
)

/** Contract `link.compose-turn`. */
data class GeneratedLinkComposeTurn(
    val text: String,
)

/** Contract `link.target-select`. */
data class GeneratedLinkTargetSelect(
    val targetId: String,
)

/** Contract `link.history-status`. */
data class GeneratedLinkHistoryStatus(
    val retainedTurns: Long,
    val maxTurns: Long,
    val targetId: String?,
    val clearableTurns: Long,
)

/** Contract `link.history-clear`. */
data class GeneratedLinkHistoryClear(
    val targetId: String,
)

/** Contract `link.preferences-status`. */
data class GeneratedLinkPreferencesStatus(
    val handsFree: Boolean,
    val speakReplies: Boolean,
    val wakeWord: Boolean,
)
