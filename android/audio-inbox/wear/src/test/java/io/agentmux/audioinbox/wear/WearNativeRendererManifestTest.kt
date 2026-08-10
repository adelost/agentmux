package io.agentmux.audioinbox.wear

import com.adelost.releasekit.UpdateState
import io.agentmux.linkcore.LinkState
import io.agentmux.linkui.product.LinkNativeManifestExporter
import io.agentmux.linkui.product.LinkNavigationController
import io.agentmux.linkui.product.LinkProductGraph
import io.agentmux.linkui.product.LinkProductSinks
import io.agentmux.linkui.product.generated.GeneratedLinkArtifactRef
import java.nio.file.Files
import java.nio.file.Path
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flowOf
import org.junit.Assert.assertEquals
import org.junit.Test

class WearNativeRendererManifestTest {
    @Test fun schema6ManifestComesFromWearRegistrations() {
        val graph = graph()
        try {
            val manifest = LinkNativeManifestExporter.export(
                GeneratedLinkArtifactRef.WEAR_FULL_UI,
                graph.nativeWearRendererRegistrations(),
                "wear/src/main/java/io/agentmux/audioinbox/wear/WearLinkNativeRendererRegistrations.kt",
            )
            val target = repoRoot().resolve("product-spec/native-registry/wear.json")
            if (System.getenv("LINK_UPDATE_NATIVE_REGISTRY") == "1") Files.write(target, manifest.toByteArray())
            assertEquals(manifest, Files.readAllBytes(target).toString(Charsets.UTF_8))
        } finally { graph.close() }
    }

    private fun graph() = LinkProductGraph(
        CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
        MutableStateFlow(LinkState()),
        MutableStateFlow(UpdateState.UpToDate("test", null)),
        MutableStateFlow(false), MutableStateFlow(false), { false }, { null },
        { 0L }, { null }, { 0f }, flowOf(""), { "" }, "test", null,
        MutableSharedFlow(), LinkNavigationController(GeneratedLinkArtifactRef.WEAR_FULL_UI),
        LinkProductSinks({}, {}, {}, {}, {}, {}, {}, {}, {}, {}),
    )

    private fun repoRoot(): Path = generateSequence(Path.of(System.getProperty("user.dir")).toAbsolutePath()) {
        it.parent
    }.first { Files.exists(it.resolve("settings.gradle.kts")) }
}
