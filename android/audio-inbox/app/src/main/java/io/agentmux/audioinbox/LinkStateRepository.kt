package io.agentmux.audioinbox

import android.content.SharedPreferences
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.LinkHistoryPolicy
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal class LinkStateRepository(
    private val preferences: SharedPreferences,
) {
    @Synchronized
    fun load(): LinkState {
        val encoded = preferences.getString(AppContract.KEY_LINK_STATE_V2, null)
        if (!encoded.isNullOrBlank()) {
            return runCatching { parse(JSONObject(encoded)) }.getOrElse {
                preferences.edit()
                    .putString(AppContract.KEY_LINK_STATE_V2_QUARANTINE, encoded)
                    .apply()
                LinkState(
                    recoveryError = "Conversation cache is damaged; raw data was quarantined",
                    handsFree = preferences.getBoolean(AppContract.KEY_ENABLED, false),
                )
            }
        }
        return importLegacy()
    }

    @Synchronized
    fun save(state: LinkState) {
        val turns = JSONArray()
        LinkHistoryPolicy.retain(state.turns).forEach { turn ->
            turns.put(
                JSONObject()
                    .put("turnId", turn.turnId)
                    .put("targetId", turn.targetId)
                    .put("targetLabel", turn.targetLabel)
                    .put("userText", turn.userText)
                    .put("replyText", turn.replyText)
                    .put("respondingTarget", turn.respondingTarget)
                    .put("createdAtMs", turn.createdAtMs)
                    .put("replyReceivedAtMs", turn.replyReceivedAtMs)
                    .put("deliveryPhase", turn.deliveryPhase.name)
                    .put("replyPhase", turn.replyPhase.name)
                    .put("playbackPhase", turn.playbackPhase.name)
                    .put("deliveryError", turn.deliveryError)
                    .put("replyError", turn.replyError)
                    .put("playbackError", turn.playbackError),
            )
        }
        val json = JSONObject()
            .put("schemaVersion", 2)
            .put("selectedTargetId", state.selectedTargetId)
            .put("recoveryError", state.recoveryError)
            .put("turns", turns)
        preferences.edit().putString(AppContract.KEY_LINK_STATE_V2, json.toString()).apply()
    }

    private fun parse(json: JSONObject): LinkState {
        require(json.optInt("schemaVersion") == 2)
        val turns = buildList {
            val rows = json.optJSONArray("turns") ?: JSONArray()
            for (index in 0 until rows.length()) {
                val row = rows.optJSONObject(index) ?: continue
                val turnId = row.optString("turnId").takeIf(String::isNotBlank) ?: continue
                val targetId = row.optString("targetId").takeIf(String::isNotBlank) ?: continue
                val delivery = DeliveryPhase.valueOf(row.getString("deliveryPhase"))
                val reply = ReplyPhase.valueOf(row.getString("replyPhase"))
                val playback = PlaybackPhase.valueOf(row.getString("playbackPhase"))
                val restoredPlayback = when (playback) {
                    PlaybackPhase.QUEUED -> PlaybackPhase.IDLE
                    PlaybackPhase.PLAYING, PlaybackPhase.PAUSED -> PlaybackPhase.STOPPED
                    else -> playback
                }
                add(
                    LinkTurn(
                        turnId = turnId,
                        targetId = targetId,
                        targetLabel = row.optionalText("targetLabel").ifBlank { targetId },
                        userText = row.optionalText("userText"),
                        replyText = row.optionalText("replyText"),
                        respondingTarget = row.optionalText("respondingTarget"),
                        createdAtMs = row.optLong("createdAtMs"),
                        replyReceivedAtMs = row.optLong(
                            "replyReceivedAtMs",
                            row.optLong("createdAtMs"),
                        ),
                        deliveryPhase = delivery,
                        replyPhase = reply,
                        playbackPhase = restoredPlayback,
                        deliveryError = row.optionalText("deliveryError"),
                        replyError = row.optionalText("replyError"),
                        playbackError = row.optionalText("playbackError"),
                    ),
                )
            }
        }
        return LinkState(
            connection = ConnectionState.OFF,
            selectedTargetId = json.optString("selectedTargetId"),
            turns = LinkHistoryPolicy.retain(turns),
            handsFree = preferences.getBoolean(AppContract.KEY_ENABLED, false),
            recoveryError = json.optString("recoveryError"),
        )
    }

    private fun importLegacy(): LinkState {
        val rows = runCatching {
            JSONArray(preferences.getString(AppContract.KEY_CONVERSATION, "[]"))
        }.getOrDefault(JSONArray())
        val turns = mutableListOf<LinkTurn>()
        var pending: LinkTurn? = null
        for (index in 0 until rows.length()) {
            val row = rows.optJSONObject(index) ?: continue
            val target = row.optString("target", "agent")
            val text = row.optString("text").trim()
            if (text.isEmpty()) continue
            if (row.optString("role") == "user") {
                pending?.let(turns::add)
                pending = LinkTurn(
                    turnId = "legacy-${UUID.randomUUID()}",
                    targetId = target,
                    targetLabel = target,
                    userText = text,
                    createdAtMs = 0,
                    deliveryPhase = DeliveryPhase.QUEUED,
                    replyPhase = ReplyPhase.THINKING,
                )
            } else {
                val user = pending ?: LinkTurn(
                    turnId = "legacy-${UUID.randomUUID()}",
                    targetId = target,
                    targetLabel = target,
                    userText = "",
                    createdAtMs = 0,
                )
                turns += user.copy(
                    replyText = text,
                    respondingTarget = target,
                    replyReceivedAtMs = 0,
                    deliveryPhase = DeliveryPhase.QUEUED,
                    replyPhase = ReplyPhase.READY,
                )
                pending = null
            }
        }
        pending?.let(turns::add)
        return LinkState(
            selectedTargetId = preferences.getString(
                AppContract.KEY_CONVERSATION_TARGET,
                "",
            ).orEmpty(),
            turns = LinkHistoryPolicy.retain(turns),
            handsFree = preferences.getBoolean(AppContract.KEY_ENABLED, false),
        )
    }
}

private fun JSONObject.optionalText(key: String): String =
    if (isNull(key)) {
        ""
    } else {
        optString(key).trim().takeUnless { it.equals("null", ignoreCase = true) }.orEmpty()
    }
