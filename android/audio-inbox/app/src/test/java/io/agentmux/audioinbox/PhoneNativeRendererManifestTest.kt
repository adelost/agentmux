package io.agentmux.audioinbox

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

class PhoneNativeRendererManifestTest {
    @Test fun schema6ManifestComesFromPhoneRegistrations() {
        val graph = graph()
        try {
            val registrations = graph.nativePhoneRendererRegistrations()
            val manifest = LinkNativeManifestExporter.export(
                GeneratedLinkArtifactRef.PHONE_FULL_UI,
                registrations,
                "app/src/main/java/io/agentmux/audioinbox/PhoneLinkNativeRendererRegistrations.kt",
            )
            val target = repoRoot().resolve("product-spec/native-registry/phone.json")
            if (System.getenv("LINK_UPDATE_NATIVE_REGISTRY") == "1") {
                Files.write(target, manifest.toByteArray())
            }
            assertEquals(manifest, Files.readAllBytes(target).toString(Charsets.UTF_8))
            val withoutTalk = registrations.filterNot { it.component.wireId == "talk" }
            require(withoutTalk.size + 1 == registrations.size)
            val swapped = registrations.map { registration ->
                if (registration.component.wireId != "target") registration else registration.copy(
                    immutableInputs = registration.immutableInputs.reversed(),
                )
            }
            require(swapped.single { it.component.wireId == "target" }.immutableInputs !=
                registrations.single { it.component.wireId == "target" }.immutableInputs)
        } finally { graph.close() }
    }

    private fun graph() = LinkProductGraph(
        CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
        MutableStateFlow(LinkState()),
        MutableStateFlow(UpdateState.UpToDate("test", null)),
        MutableStateFlow(false), MutableStateFlow(false), { false }, { null },
        { 0L }, { null }, { 0f }, flowOf(""), { "" }, "test", null,
        MutableSharedFlow(), LinkNavigationController(GeneratedLinkArtifactRef.PHONE_FULL_UI),
        LinkProductSinks({}, {}, {}, {}, {}, {}, {}, {}, {}, {}),
    )

    private fun repoRoot(): Path = generateSequence(Path.of(System.getProperty("user.dir")).toAbsolutePath()) {
        it.parent
    }.first { Files.exists(it.resolve("settings.gradle.kts")) }
}
