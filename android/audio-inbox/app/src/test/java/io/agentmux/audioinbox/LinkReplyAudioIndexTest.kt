package io.agentmux.audioinbox

import io.agentmux.linkcore.LinkAction
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.ReplyPhase
import io.agentmux.linkui.LinkReplyAudio
import io.agentmux.linkui.readAloudText
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.Executor

// Mattias 2026-09-14: "Man borde ju ha laddat ner ljudfilen sen innan så att man har svaret."
class LinkReplyAudioIndexTest {
    @get:Rule val folder = TemporaryFolder()

    private val server = "http://10.0.0.2:8080"
    private val target = ConversationTarget("lsrc:3", "lsrc:3", ConversationTarget.Kind.AGENT, server, "1000000000", "lsrc", 3)
    private val reply = LinkTurn("t1", "lsrc:3", "lsrc:3", "Hej", replyText = "Ja, meddelandet kom fram.", createdAtMs = 1, replyPhase = ReplyPhase.READY)
    private val now = Executor { it.run() }
    private val requests = mutableListOf<String>()
    private val speech: (String, String) -> File = { _, text ->
        requests += text
        File.createTempFile("tts-", ".mp3", folder.root).also { it.writeBytes(byteArrayOf(1, 2, 3)) }
    }

    @Test
    fun aReplyThatLandsIsSavedBeforeAnyTapSoReadAloudNeverWaitsOnTheServer() {
        val cache = ReplyAudioCache(folder.newFolder("files"))
        val index = LinkReplyAudioIndex(cache, speech, now, durationOf = { 8_000L })

        index.prepare(reply, target)

        assertEquals(LinkReplyAudio.Saved(8_000L), index.audioFor(reply, target))
        cache.materialize(server, reply.readAloudText(), File(folder.root, "tap.mp3")) { error("a tap must not ask the server again") }
        assertEquals(listOf(reply.readAloudText()), requests)
        assertEquals(1, index.saved.value)
    }

    @Test
    fun aReplyWithNothingToSayOrNoReachableServerIsNotFetched() {
        val index = LinkReplyAudioIndex(ReplyAudioCache(folder.newFolder("files")), speech, now, durationOf = { 0L })

        index.prepare(reply.copy(replyText = ""), target)
        index.prepare(reply, null)
        index.prepare(reply, ConversationTarget("x", "x", ConversationTarget.Kind.AGENT, "http://example.com", "1", "x", 1))

        assertEquals(emptyList<String>(), requests)
    }

    @Test
    fun onlyAReplyThatJustBecameReadyCountsAsLanded() {
        val waiting = LinkState(turns = listOf(reply.copy(replyText = "", replyPhase = ReplyPhase.NONE)))
        val answered = LinkState(turns = listOf(reply))
        val action = LinkAction.Reply("t1", "lsrc:3", reply.replyText)

        assertEquals(reply, landedReply(waiting, answered, action))
        assertEquals(null, landedReply(answered, answered, action))
    }
}
