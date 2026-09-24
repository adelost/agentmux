package io.agentmux.audioinbox

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkConversationFollowTest {
    @Test fun newContentFollowsOnlyWhileTheReaderFollowsTheEnd() {
        assertTrue(updatedFollowLatest(true, userScrolling = false, lastVisibleIndex = 0, conversationItems = 4))
        assertFalse(updatedFollowLatest(true, userScrolling = true, lastVisibleIndex = 1, conversationItems = 4))
        assertFalse(updatedFollowLatest(false, userScrolling = false, lastVisibleIndex = 3, conversationItems = 5))
        assertTrue(updatedFollowLatest(false, userScrolling = true, lastVisibleIndex = 4, conversationItems = 5))
    }
}
