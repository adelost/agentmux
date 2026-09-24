package io.agentmux.linkui.product

import android.app.Activity

/** Release deliberately contains no native Studio transport or receiver. */
object LinkStudioBootstrap {
    fun attach(@Suppress("UNUSED_PARAMETER") activity: Activity,
               @Suppress("UNUSED_PARAMETER") productGraph: LinkProductGraph) = Unit
    fun detach(@Suppress("UNUSED_PARAMETER") activity: Activity) = Unit
}
