package io.agentmux.audioinbox

import io.agentmux.linkui.LinkPlaybackControls
import io.agentmux.linkui.linkAudioPreferences

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.adelost.designkit.ui.CircleChoiceRole
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.releasekit.ui.releaseUpdateRows
import com.adelost.releasekit.updateTargetChangelog
import com.adelost.ringkit.ui.PhoneScreenHeader
import com.adelost.ringkit.ui.RingChoiceRow
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkPreferenceKey
import io.agentmux.linkcore.LinkRecoveryPhase
import io.agentmux.linkcore.LinkUpdateOperation
import io.agentmux.linkcore.PlaybackOperation
import io.agentmux.linkui.activeTurnId
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.LinkWakePresentation
import androidx.compose.ui.res.vectorResource
import androidx.compose.ui.graphics.vector.ImageVector
import io.agentmux.linkui.product.wakePhaseWord
import io.agentmux.linkui.linkWakeToggleLabels
import io.agentmux.linkui.product.wakeSensitivityWord
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakePhrase
import io.agentmux.wakeword.WakePhrases
import androidx.compose.ui.platform.LocalContext
import io.agentmux.linkui.product.LinkPlaybackCommandEvent
import io.agentmux.linkui.product.LinkPreferenceToggleEvent
import io.agentmux.linkui.linkClearConversationRow
import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.LinkRouteOpenEvent
import io.agentmux.linkui.product.LinkUpdateCommandEvent
import com.adelost.designkit.ui.CircleActionTiming
import io.agentmux.linkui.product.generated.GeneratedLinkControlTiming
import io.agentmux.linkui.product.generated.GeneratedLinkRoutes
import io.agentmux.linkui.product.generated.GeneratedLinkSettingsComponent
import io.agentmux.linkui.product.generated.GeneratedLinkSettingsComponents

/**
 * Secondary behavior and connection controls stay off the conversation
 * surface. Every row remains a shared CircleKit atom; this file is wiring.
 */
@Composable
internal fun LinkPhoneSettings(
    graph: PhoneLinkProductGraph,
    currentVersionName: String,
    onBack: () -> Unit,
    onPublicLink: () -> Unit,
) {
    val playback by graph.activePlayback.collectAsStateWithLifecycle()
    val connection by graph.connection.collectAsStateWithLifecycle()
    val publicLink by graph.publicLink.collectAsStateWithLifecycle()
    val preferences by graph.preferences.collectAsStateWithLifecycle()
    val localHistory by graph.localHistory.collectAsStateWithLifecycle()
    val updates by graph.updates.collectAsStateWithLifecycle()
    val recovery by graph.recovery.collectAsStateWithLifecycle()
    val wake by graph.wake.collectAsStateWithLifecycle()
    val updateRows = releaseUpdateRows(
        state = updates.update,
        currentVersionName = currentVersionName,
        onCheck = { graph.onUpdatesCommand(LinkUpdateCommandEvent(LinkUpdateOperation.RETRY)) },
        onInstall = { graph.onUpdatesCommand(LinkUpdateCommandEvent(LinkUpdateOperation.INSTALL)) },
    )
    val updateChangelog = updateTargetChangelog(updates.update)
    // Read inside the composable, not inside the LazyListScope builder: the
    // builder lambda is not a composable context, so `.current` is unreadable
    // there. The declared tree for this surface does not change while the list
    // is being built, so resolving it once here is also the honest lifetime.
    val settingsRoute = GeneratedLinkRoutes.descriptor(LinkRoute.SETTINGS)
    val settingsTree = GeneratedLinkSettingsComponents.resolve(
        LocalCircleSurfaceLayout.current.surfaceClass,
    )
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item("header") {
            PhoneScreenHeader(
                title = settingsRoute.title,
                onBack = onBack,
                backLabel = "Back",
                icon = LinkNativeBindings.requireIcon(settingsRoute.iconAssetRef),
            )
        }
        settingsTree
            .orderedMounts.forEach { mount ->
                when (mount.component) {
                    GeneratedLinkSettingsComponent.NAVIGATION_PAGE_HOST -> Unit
                    GeneratedLinkSettingsComponent.PLAYBACK_CONTROLS -> playback.activeTurnId
                        ?.let { id -> playback.turn?.takeIf { it.turnId == id } }
                        ?.let { active ->
                            item(mount.id) {
                                LinkPlaybackControls(
                                    turn = active,
                                    onPlay = {},
                                    onPause = {
                                        graph.onActivePlaybackCommand(
                                            LinkPlaybackCommandEvent(PlaybackOperation.PAUSE, active.turnId),
                                        )
                                    },
                                    onResume = {
                                        graph.onActivePlaybackCommand(
                                            LinkPlaybackCommandEvent(PlaybackOperation.RESUME, active.turnId),
                                        )
                                    },
                                    onStop = {
                                        graph.onActivePlaybackCommand(
                                            LinkPlaybackCommandEvent(PlaybackOperation.STOP, active.turnId),
                                        )
                                    },
                                )
                            }
                        }
                    GeneratedLinkSettingsComponent.SESSION_CONNECTION -> item(mount.id) {
                        PhoneRow(
                            title = connectionRouteLabel(connection.connectionDetail.orEmpty()),
                            sub = connection.connectionDetail.orEmpty()
                                    .ifBlank { "Not connected" },
                            icon = if (connection.connection == ConnectionState.CONNECTED) {
                                LinkNativeBindings.requireIcon("wifi")
                            } else {
                                LinkNativeBindings.requireIcon("link")
                            },
                        )
                    }
                    GeneratedLinkSettingsComponent.SESSION_PUBLIC_LINK -> item(mount.id) {
                        PhoneRow(
                            title = if (publicLink.publicLinkActive) {
                                "SIGN OUT"
                            } else {
                                "CONNECT ONLINE"
                            },
                            sub = if (publicLink.publicLinkActive) {
                                "Online account connected"
                            } else {
                                ""
                            },
                            icon = LinkNativeBindings.requireIcon("link"),
                            press = LinkPress(GeneratedLinkControlTiming.SETTINGS_PUBLIC_LINK, onPublicLink),
                        )
                    }
                    GeneratedLinkSettingsComponent.PREFERENCES_TOGGLES -> {
                        linkAudioPreferences(
                            preferences.speakReplies,
                            preferences.handsFree,
                            preferences.wakeWord,
                            preferences.listeningCueSound,
                        ).forEach { preference ->
                            item("${mount.id}.${preference.key}") {
                                // The wake word's toggle says what it is listening for, so the page needs
                                // no status row of its own (lsrc:0 S1, 2026-09-19). The labels are the
                                // choice's two options, the way the phrase and sensitivity rows read too.
                                val (off, on) = if (preference.key == LinkPreferenceKey.WAKE_WORD) {
                                    linkWakeToggleLabels(wake)
                                } else {
                                    "OFF" to "ON"
                                }
                                RingChoiceRow(
                                    title = preference.title,
                                    hint = preference.hint,
                                    selected = if (preference.enabled) on else off,
                                    options = listOf(off, on),
                                    role = CircleChoiceRole.TOGGLE,
                                    infoSelected = true,
                                    onSelect = {
                                        graph.onPreferencesToggle(
                                            LinkPreferenceToggleEvent(preference.key, it == on),
                                        )
                                    },
                                    icon = LinkNativeBindings.requireIcon(
                                        if (preference.key == LinkPreferenceKey.WAKE_WORD) "record" else "speaker",
                                    ),
                                    actionTiming = linkPreferenceTiming(preference.key),
                                    modifier = phoneRowModifier(),
                                )
                            }
                        }
                    }
                    GeneratedLinkSettingsComponent.WAKE_STATUS -> if (preferences.wakeWord || wake.phase != WakePhase.OFF) {
                        item("${mount.id}.phrase") {
                            val context = LocalContext.current
                            RingChoiceRow(
                                title = "WAKE PHRASE",
                                selected = wakePhraseLabel(wake.phrase),
                                options = WakePhrases.offered.map(::wakePhraseLabel),
                                role = CircleChoiceRole.STEPPED,
                                onSelect = { label ->
                                    LinkWakePhraseChoice.choose(context, WakePhrases.offered.first { wakePhraseLabel(it) == label })
                                },
                                icon = LinkNativeBindings.requireIcon("record"),
                                actionTiming = GeneratedLinkControlTiming.SETTINGS_WAKE_PHRASE,
                                modifier = phoneRowModifier(),
                            )
                        }
                        // Only a blocked loop still gets a row of its own: its reason is the one fact
                        // about the wake word that nothing else on this page states.
                        if (wake.phase == WakePhase.BLOCKED) {
                            item(mount.id) {
                                PhoneRow(
                                    title = wakePhaseWord(wake.phase),
                                    sub = wakeStatusDetail(wake),
                                    icon = ImageVector.vectorResource(wakeGlyphDrawable(wake.phase)),
                                )
                            }
                        }
                    }
                    GeneratedLinkSettingsComponent.HISTORY_LOCAL -> {
                        item(mount.id) {
                            PhoneRow(
                                title = "LOCAL HISTORY",
                                sub = "${localHistory.retainedTurns} recent · up to ${localHistory.maxTurns}",
                                icon = LinkNativeBindings.requireIcon("activity"),
                            )
                        }
                        linkClearConversationRow(localHistory, LinkNativeBindings.requireIcon("trash"), graph::onLocalHistoryClear)
                            ?.let { row -> item(row.key) { PhoneRow(row) } }
                    }
                    GeneratedLinkSettingsComponent.UPDATES_PANEL -> {
                        updateRows.forEach { row -> item(row.key) { PhoneRow(row) } }
                        if (updateChangelog.isNotBlank()) {
                            item("update-changelog") {
                                PhoneRow(
                                    "WHAT'S NEW",
                                    updateChangelog,
                                    LinkNativeBindings.requireIcon("download"),
                                )
                            }
                        }
                    }
                    // Row 217: where SENSITIVITY used to cycle through three words in place. Choosing a
                    // step and hearing what it does were two rows on two pages, so the row now shows the
                    // step and opens the page that can try it. It is offered with the wake word off as
                    // well, because whether Link hears you is the question you ask before turning it on.
                    GeneratedLinkSettingsComponent.NAVIGATION_WAKE_TRY_ENTRY -> item(mount.id) {
                        PhoneRow(
                            title = "SENSITIVITY",
                            sub = "${wakeSensitivityWord(wake.sensitivity)} · try the phrase and choose",
                            icon = LinkNativeBindings.requireIcon(
                                GeneratedLinkRoutes.descriptor(LinkRoute.WAKE_TRY).iconAssetRef,
                            ),
                            press = LinkPress(GeneratedLinkControlTiming.SETTINGS_SENSITIVITY) {
                                graph.onWakeTryOpen(LinkRouteOpenEvent(LinkRoute.WAKE_TRY))
                            },
                        )
                    }
                    // The debug page belongs to the wake word, so it appears with it and not before it.
                    GeneratedLinkSettingsComponent.NAVIGATION_WAKE_DEBUG_ENTRY ->
                        if (preferences.wakeWord || wake.phase != WakePhase.OFF) {
                            item(mount.id) {
                                // The row opens a page, so it wears that page's declared glyph rather than
                                // one chosen here. lsrc:0 S2, 2026-09-19: it wore LOCAL HISTORY's chart,
                                // and two different pages looked like one.
                                val route = GeneratedLinkRoutes.descriptor(LinkRoute.WAKE_DEBUG)
                                PhoneRow(
                                    title = route.title,
                                    sub = "What it hears, and what it refused",
                                    icon = LinkNativeBindings.requireIcon(route.iconAssetRef),
                                    press = LinkPress(GeneratedLinkControlTiming.SETTINGS_WAKE_DEBUG) {
                                        graph.onWakeDebugOpen(LinkRouteOpenEvent(LinkRoute.WAKE_DEBUG))
                                    },
                                )
                            }
                        }
                    GeneratedLinkSettingsComponent.NAVIGATION_DEV_HOST_ENTRY -> item(mount.id) {
                        PhoneRow(
                            title = "DISPLAY PREVIEW",
                            sub = "Phone layout or watch-size preview",
                            icon = LinkNativeBindings.requireIcon("phone"),
                            press = LinkPress(GeneratedLinkControlTiming.SETTINGS_DISPLAY_PREVIEW) {
                                graph.onDevHostOpen(LinkRouteOpenEvent(LinkRoute.DEV_HOST))
                            },
                        )
                    }
                    GeneratedLinkSettingsComponent.RECOVERY_STATUS -> if (recovery.phase == LinkRecoveryPhase.QUARANTINED) {
                        item(mount.id) {
                            PhoneRow(
                                "RECOVERY",
                                recovery.detail.orEmpty(),
                                LinkNativeBindings.requireIcon("warning"),
                            )
                        }
                    }
                }
            }
    }
}

internal fun connectionRouteLabel(detail: String): String = when {
    detail.contains("public", ignoreCase = true) -> "PUBLIC LINK"
    detail.contains("tailscale", ignoreCase = true) ||
        detail.contains("private", ignoreCase = true) -> "PRIVATE LINK"
    else -> "CONNECTION"
}

/** The status row's title already names the phrase; below it only why listening stopped, if it did. */
internal fun wakeStatusDetail(wake: LinkWakePresentation): String = wake.detail.orEmpty()

/** The picker shows exactly what to say. */
internal fun wakePhraseLabel(phrase: WakePhrase): String = phrase.spoken.uppercase()

/** Each audio preference toggle names its own declared kind; see product-spec/src/interactions.ts. */
private fun linkPreferenceTiming(key: LinkPreferenceKey): CircleActionTiming = when (key) {
    LinkPreferenceKey.WAKE_WORD -> GeneratedLinkControlTiming.SETTINGS_WAKE_WORD
    LinkPreferenceKey.SPEAK_REPLIES -> GeneratedLinkControlTiming.SETTINGS_SPEAK_REPLIES
    LinkPreferenceKey.HANDS_FREE -> GeneratedLinkControlTiming.SETTINGS_HANDS_FREE
    LinkPreferenceKey.LISTENING_CUE_SOUND -> GeneratedLinkControlTiming.SETTINGS_LISTENING_CUE_SOUND
}
