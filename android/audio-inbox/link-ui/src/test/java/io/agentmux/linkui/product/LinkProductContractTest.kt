package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.LinkArtifactProfile
import io.agentmux.linkui.product.generated.LinkProductManifest
import io.agentmux.linkui.product.generated.LinkRoute
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkProductContractTest {
    @Test
    fun `one generated product binds every supported Phone and Wear surface`() {
        LinkArtifactProfile.entries.forEach { profile ->
            val product = LinkProductSession(profile)
            profile.surfaces.forEach { surface ->
                assertTrue(product.components(LinkRoute.HOME, surface).isNotEmpty())
                assertTrue(product.components(LinkRoute.SETTINGS, surface).isNotEmpty())
            }
        }
        assertEquals(
            setOf("navigation", "capture", "delivery", "reply", "playback"),
            LinkProductManifest.services.map { it.id }.toSet(),
        )
        assertEquals("durable", LinkProductManifest.services.single { it.id == "delivery" }.durability)
        assertEquals("wall", LinkProductManifest.services.single { it.id == "reply" }.clockDomain)
    }

    @Test
    fun `compiled native registry is independent and matches its ProductSpec snapshot`() {
        val root = findLinkRoot()
        val target = root.resolve("product-spec/native-registry/link.json")
        val snapshot = snapshot()
        if (System.getenv("LINK_UPDATE_NATIVE_REGISTRY") == "1") {
            Files.createDirectories(target.parent)
            Files.write(target, snapshot.toByteArray(Charsets.UTF_8))
        }
        assertEquals(
            "Run this focused test with LINK_UPDATE_NATIVE_REGISTRY=1 after an intentional binding change.",
            snapshot,
            Files.readAllBytes(target).toString(Charsets.UTF_8),
        )
        val source = Files.readAllBytes(root.resolve(LinkNativeBindings.SOURCE_FILE)).toString(Charsets.UTF_8)
        assertFalse(source.contains("LinkProductManifest"))
        assertFalse(source.contains("GeneratedLinkProduct"))
    }

    private fun snapshot(): String {
        val profiles = LinkNativeBindings.profiles.joinToString(", ") { it.json() }
        val components = LinkNativeBindings.components.joinToString(",\n") { binding ->
            val supported = binding.profiles.joinToString(", ") { it.json() }
            "    { \"componentId\": ${binding.componentId.json()}, \"rendererId\": ${binding.renderer.id.json()}, \"profiles\": [$supported] }"
        }
        val icons = LinkNativeBindings.icons.joinToString(",\n") { binding ->
            "    { \"iconId\": ${binding.iconId.json()}, \"nativeSymbol\": ${binding.nativeSymbol.json()} }"
        }
        val palettes = LinkNativeBindings.palettes.joinToString(",\n") { binding ->
            val supported = binding.profiles.joinToString(", ") { it.json() }
            "    { \"paletteId\": ${binding.paletteId.json()}, \"nativeSymbol\": ${binding.nativeSymbol.json()}, \"profiles\": [$supported] }"
        }
        val services = LinkNativeBindings.services.joinToString(",\n") { binding ->
            val supported = binding.profiles.joinToString(", ") { it.json() }
            val inputs = binding.inputPorts.joinToString(", ") { it.json() }
            val outputs = binding.outputPorts.joinToString(", ") { it.json() }
            "    { \"serviceId\": ${binding.serviceId.json()}, \"nativePortId\": ${binding.port.id.json()}, \"profiles\": [$supported], \"inputPorts\": [$inputs], \"outputPorts\": [$outputs] }"
        }
        return """
            |{
            |  "stage": "native-export",
            |  "schemaVersion": ${LinkNativeBindings.SCHEMA_VERSION},
            |  "sourceFile": ${LinkNativeBindings.SOURCE_FILE.json()},
            |  "profiles": [$profiles],
            |  "components": [
            |$components
            |  ],
            |  "icons": [
            |$icons
            |  ],
            |  "palettes": [
            |$palettes
            |  ],
            |  "services": [
            |$services
            |  ]
            |}
        """.trimMargin() + "\n"
    }

    private fun findLinkRoot(): Path = generateSequence(
        Path.of(System.getProperty("user.dir")).toAbsolutePath(),
    ) { it.parent }.first { Files.exists(it.resolve("settings.gradle.kts")) }

    private fun String.json(): String = buildString {
        append('"')
        for (char in this@json) when (char) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> append(char)
        }
        append('"')
    }
}
