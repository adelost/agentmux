package io.agentmux.wakeword

import org.junit.Assert.assertEquals
import org.junit.Test

class WakeSessionTest {
    private fun sent(): WakeStatus = WakeStatus()
        .reduce(WakeEvent.Start)
        .reduce(WakeEvent.Detected(0.97f))
        .reduce(WakeEvent.CaptureEnded(UtteranceEnd.COMPLETE, "t1"))

    private fun WakeStatus.after(stage: TurnStage, error: String = "") =
        reduce(WakeEvent.TurnChanged(TurnProgress(stage, error)))

    @Test
    fun aQuestionTravelsThroughThinkingAndSpeakingIntoAFollowUpWindow() {
        val phases = listOf(TurnStage.SENDING, TurnStage.THINKING, TurnStage.SPEAKING, TurnStage.SPOKEN)
            .runningFold(sent()) { status, stage -> status.after(stage) }
            .map { it.phase }
        assertEquals(
            listOf(WakePhase.SENDING, WakePhase.SENDING, WakePhase.THINKING, WakePhase.SPEAKING, WakePhase.FOLLOW_UP),
            phases,
        )
    }

    @Test
    fun whatTheMicrophoneHearsShowsOnlyWhileAQuestionIsCapturedAndClearsWhenItIsSent() {
        val heard = WakeHearing(level = 0.6f, heardSpeech = true, sendsInMs = 1_700)
        val listening = WakeStatus().reduce(WakeEvent.Start)
        assertEquals(null, listening.reduce(WakeEvent.Heard(heard)).hearing)
        val capturing = listening.reduce(WakeEvent.Detected(0.97f)).reduce(WakeEvent.Heard(heard))
        assertEquals(heard, capturing.hearing)
        assertEquals(null, capturing.reduce(WakeEvent.CaptureEnded(UtteranceEnd.COMPLETE, "t1")).hearing)
        assertEquals(null, capturing.reduce(WakeEvent.CaptureEnded(UtteranceEnd.NO_SPEECH, null)).hearing)
    }

    @Test
    fun aFailedSendReturnsToListeningAndSaysWhy() {
        val status = sent().after(TurnStage.SEND_FAILED, "offline")
        assertEquals(WakePhase.LISTENING to "Could not send · offline", status.phase to status.detail)
    }

    @Test
    fun aFailedReadAloudReturnsToListeningAndSaysWhy() {
        val status = sent().after(TurnStage.SPEAK_FAILED, "tts 500")
        assertEquals(WakePhase.LISTENING to "Could not read the reply · tts 500", status.phase to status.detail)
    }

    @Test
    fun theWakeWordInterruptsAReplyBeingRead() {
        val interrupted = sent().after(TurnStage.SPEAKING).reduce(WakeEvent.Detected(0.9f))
        assertEquals(WakePhase.CAPTURING to null, interrupted.phase to interrupted.turnId)
    }

    @Test
    fun silenceInTheFollowUpWindowReturnsQuietlyToTheWakeWord() {
        val window = sent().after(TurnStage.SPOKEN)
        assertEquals(WakePhase.FOLLOW_UP to 1, window.phase to window.followUps)
        val quiet = window.reduce(WakeEvent.CaptureEnded(UtteranceEnd.NO_SPEECH, null))
        assertEquals(WakePhase.LISTENING to "", quiet.phase to quiet.detail)
    }

    @Test
    fun aFollowUpQuestionIsSentWithoutTheWakeWord() {
        val followUp = sent().after(TurnStage.SPOKEN).reduce(WakeEvent.CaptureEnded(UtteranceEnd.COMPLETE, "t2"))
        assertEquals(WakePhase.SENDING to "t2", followUp.phase to followUp.turnId)
    }

    @Test
    fun aNewQuestionWhileThinkingStopsFollowingTheOldTurn() {
        val asking = sent().after(TurnStage.THINKING).reduce(WakeEvent.Detected(0.8f))
        assertEquals(WakePhase.CAPTURING to null, asking.phase to asking.turnId)
        assertEquals(asking, asking.after(TurnStage.SPOKEN))
    }

    @Test
    fun silenceAfterTheWakeWordSendsNothing() {
        val status = WakeStatus().reduce(WakeEvent.Start).reduce(WakeEvent.Detected(0.9f))
            .reduce(WakeEvent.CaptureEnded(UtteranceEnd.NO_SPEECH, null))
        assertEquals(WakeStatus(WakePhase.LISTENING, null, "Heard the wake word but no question", 0.9f, 1), status)
    }
}
