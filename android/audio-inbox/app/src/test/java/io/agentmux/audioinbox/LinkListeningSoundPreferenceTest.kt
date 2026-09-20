package io.agentmux.audioinbox

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class LinkListeningSoundPreferenceTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before fun clear() {
        context.getSharedPreferences(AppContract.PREFS, Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test fun soundStartsOnAndAStoredOffChoiceSurvivesAReaderRestart() {
        val first = LinkListeningSoundPreference(context)
        assertTrue(first.enabled.value)

        first.setEnabled(false)

        assertFalse(first.enabled.value)
        assertFalse(LinkListeningSoundPreference(context).enabled.value)
        assertFalse(LinkListeningSoundPreference.isEnabled(context))
    }
}
