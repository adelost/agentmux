package io.agentmux.linkui.product

import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Test

/** Emits schema 5 only from the compile-bound native registrations. */
class LinkNativeBindingManifestTest {
    @Test
    fun nativeRegistryMatchesCompiledBindings() {
        val target = repoRoot().resolve("product-spec/native-registry/link.json")
        val snapshot = manifest()
        if (System.getenv("LINK_UPDATE_NATIVE_REGISTRY") == "1") {
            Files.write(target, snapshot.toByteArray(Charsets.UTF_8))
        }
        assertEquals(
            "Run :link-ui:testDebugUnitTest with LINK_UPDATE_NATIVE_REGISTRY=1 after an " +
                "intentional native binding change, then run the ProductSpec conformance test.",
            snapshot,
            Files.readAllBytes(target).toString(Charsets.UTF_8),
        )
    }

    private fun manifest(): String =
        """
            |{
            |  "stage": "native-export",
            |  "schemaVersion": ${LinkNativeBindings.SCHEMA_VERSION},
            |  "sourceFile": ${LinkNativeBindings.SOURCE_FILE.json()},
            |  "profiles": ${LinkNativeBindings.profiles.map { it.wireId }.sorted().jsonArray()},
            |  "components": [
            |${components()}
            |  ],
            |  "icons": [
            |${icons()}
            |  ],
            |  "nodes": [
            |${nodes()}
            |  ],
            |  "finiteValues": [
            |${finiteValues()}
            |  ],
            |  "navigation": {
            |    "artifacts": [
            |${navigationArtifacts()}
            |    ],
            |    "activePageBindings": [
            |${activePageBindings()}
            |    ],
            |    "actionGroups": [
            |${actionGroups()}
            |    ]
            |  }
            |}
        """.trimMargin() + "\n"

    private fun components(): String = LinkNativeBindings.components
        .sortedBy { it.componentType.wireId }
        .joinToString(",\n") { binding ->
            """
                |    {
                |      "componentId": ${binding.componentType.wireId.json()},
                |      "rendererId": ${binding.rendererId.json()},
                |      "profiles": ${binding.profiles.map { it.wireId }.sorted().jsonArray()}
                |    }
            """.trimMargin()
        }

    private fun icons(): String = LinkNativeBindings.icons
        .sortedBy { it.iconId }
        .joinToString(",\n") { binding ->
            """
                |    {
                |      "iconId": ${binding.iconId.json()},
                |      "nativeSymbol": ${binding.nativeSymbol.json()}
                |    }
            """.trimMargin()
        }

    private fun nodes(): String = LinkNativeBindings.nodes
        .sortedBy { it.node.wireId }
        .joinToString(",\n") { binding ->
            """
                |    {
                |      "nodeId": ${binding.node.wireId.json()},
                |      "nativePortId": ${binding.nativePortId.json()},
                |      "profiles": ${binding.profiles.map { it.wireId }.sorted().jsonArray()},
                |      "inputPorts": ${binding.inputPorts.map { it.id.relativeTo(binding.node.wireId) }.sorted().jsonArray()},
                |      "outputPorts": ${binding.outputPorts.map { it.id.relativeTo(binding.node.wireId) }.sorted().jsonArray()}
                |    }
            """.trimMargin()
        }

    private fun finiteValues(): String = LinkNativeBindings.finiteValues
        .sortedBy { it.id.value }
        .joinToString(",\n") { binding ->
            """
                |    {
                |      "id": ${binding.id.value.json()},
                |      "values": ${binding.values.sorted().jsonArray()}
                |    }
            """.trimMargin()
        }

    private fun navigationArtifacts(): String = LinkNativeBindings.navigationArtifacts
        .sortedBy { it.artifact.wireId }
        .joinToString(",\n") { binding ->
            val pages = binding.pages.joinToString(",\n") { page ->
                """
                    |        {
                    |          "pageRef": ${page.page.wireId.json()},
                    |          "restore": ${page.restore.wireId.json()},
                    |          "back": ${page.back.wireId.json()},
                    |          "guardContractRef": ${page.guardContractRef?.json() ?: "null"}
                    |        }
                """.trimMargin()
            }
            """
                |      {
                |        "artifactRef": ${binding.artifact.wireId.json()},
                |        "entryPageRef": ${binding.entryPage.wireId.json()},
                |        "pages": [
                |$pages
                |        ]
                |      }
            """.trimMargin()
        }

    private fun activePageBindings(): String = LinkNativeBindings.activePageBindings
        .joinToString(",\n") { binding ->
            """
                |      {
                |        "publisherPortRef": ${binding.publisher.id.value.json()},
                |        "pageHostPortRef": ${binding.pageHost.id.value.json()}
                |      }
            """.trimMargin()
        }

    private fun actionGroups(): String = LinkNativeBindings.actionGroups
        .sortedWith(compareBy({ it.artifact.wireId }, { it.component.wireId }))
        .joinToString(",\n") { group ->
            val actions = group.actions.joinToString(",\n") { action ->
                """
                    |        {
                    |          "sourcePortRef": ${action.source.id.value.json()},
                    |          "targetPortRef": ${action.target.id.value.json()},
                    |          "effect": ${action.effect.wireId.json()}
                    |        }
                """.trimMargin()
            }
            """
                |      {
                |        "artifactRef": ${group.artifact.wireId.json()},
                |        "componentInstanceRef": ${group.component.wireId.json()},
                |        "actions": [
                |$actions
                |        ]
                |      }
            """.trimMargin()
        }

    private fun io.agentmux.linkui.product.generated.GeneratedProductPortId.relativeTo(
        nodeId: String,
    ): String {
        val prefix = "$nodeId."
        require(value.startsWith(prefix)) { "Port $value is not owned by $nodeId" }
        return value.removePrefix(prefix)
    }

    private fun repoRoot(): Path = generateSequence(
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

    private fun Iterable<String>.jsonArray(): String =
        joinToString(", ", "[", "]") { it.json() }
}
