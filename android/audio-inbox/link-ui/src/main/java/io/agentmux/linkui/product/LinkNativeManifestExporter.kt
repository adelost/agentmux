package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.GeneratedLinkArtifactRef
import io.agentmux.linkui.product.generated.GeneratedProductPortId

/** Schema-6 JSON derived only from executable host registrations. */
object LinkNativeManifestExporter {
    fun export(
        profile: GeneratedLinkArtifactRef,
        registrations: List<LinkNativeComponentRendererRegistration>,
        sourceFile: String,
    ): String =
        """
            |{
            |  "stage": "native-export",
            |  "schemaVersion": ${LinkNativeBindings.SCHEMA_VERSION},
            |  "sourceFile": ${sourceFile.json()},
            |  "profiles": ${listOf(profile.wireId).jsonArray()},
            |  "components": [
            |${components(registrations)}
            |  ],
            |  "icons": [
            |${icons()}
            |  ],
            |  "nodes": [
            |${nodes(profile)}
            |  ],
            |  "finiteValues": [
            |${finiteValues()}
            |  ],
            |  "navigation": {
            |    "artifacts": [
            |${navigationArtifact(profile)}
            |    ],
            |    "activePageBindings": [
            |${activePageBindings()}
            |    ],
            |    "actionGroups": [
            |${actionGroups(profile)}
            |    ]
            |  }
            |}
        """.trimMargin() + "\n"

    private fun components(registrations: List<LinkNativeComponentRendererRegistration>): String =
        registrations.sortedBy { it.component.wireId }.joinToString(",\n") { registration ->
            val mounts = registration.mounts.joinToString(",\n") { mount ->
                val scope = mount.scope.declaration
                """
                    |        {
                    |          "profileRef": ${scope.artifact.wireId.json()},
                    |          "pageRef": ${scope.page.wireId.json()},
                    |          "surface": ${scope.surface.json()},
                    |          "mountRef": ${scope.mountRef.json()}
                    |        }
                """.trimMargin()
            }
            val inputs = registration.immutableInputs.joinToString(",\n") { input ->
                val declaration = input.input.declaration
                """
                    |        {
                    |          "consumerPortRef": ${declaration.inputPortRef.json()},
                    |          "producerPortRef": ${declaration.producerPortRef.json()},
                    |          "contractRef": ${declaration.contractRef.json()},
                    |          "required": ${declaration.required}
                    |        }
                """.trimMargin()
            }
            val emitter = when (val actual = registration.eventEmitter) {
                is LinkNativeRendererEmitterRegistration.Empty -> """{ "kind": "empty" }"""
                is LinkNativeRendererEmitterRegistration.Typed -> {
                    val bindings = actual.bindings.joinToString(",\n") { binding ->
                        val event = binding.event.declaration
                        """
                            |          {
                            |            "sourcePortRef": ${event.eventPortRef.json()},
                            |            "targetPortRef": ${event.targetPortRef.json()},
                            |            "contractRef": ${event.contractRef.json()}
                            |          }
                        """.trimMargin()
                    }
                    """
                        |{
                        |        "kind": "typed",
                        |        "bindings": [
                        |$bindings
                        |        ]
                        |      }
                    """.trimMargin()
                }
            }
            """
                |    {
                |      "component": {
                |        "instanceRef": ${registration.component.wireId.json()},
                |        "typeRef": ${registration.component.type.wireId.json()}
                |      },
                |      "mounts": [
                |$mounts
                |      ],
                |      "immutableInputs": [
                |$inputs
                |      ],
                |      "eventEmitter": $emitter
                |    }
            """.trimMargin()
        }

    private fun icons(): String = LinkNativeBindings.icons.sortedBy { it.iconId }.joinToString(",\n") {
        """
            |    {
            |      "iconId": ${it.iconId.json()},
            |      "nativeSymbol": ${it.nativeSymbol.json()}
            |    }
        """.trimMargin()
    }

    private fun nodes(profile: GeneratedLinkArtifactRef): String =
        LinkNativeBindings.nodes.sortedBy { it.node.wireId }.joinToString(",\n") { binding ->
            """
                |    {
                |      "nodeId": ${binding.node.wireId.json()},
                |      "nativePortId": ${binding.nativePortId.json()},
                |      "profiles": ${listOf(profile.wireId).jsonArray()},
                |      "inputPorts": ${binding.inputPorts.map { it.id.relativeTo(binding.node.wireId) }.sorted().jsonArray()},
                |      "outputPorts": ${binding.outputPorts.map { it.id.relativeTo(binding.node.wireId) }.sorted().jsonArray()}
                |    }
            """.trimMargin()
        }

    private fun finiteValues(): String = LinkNativeBindings.finiteValues.sortedBy { it.id.value }
        .joinToString(",\n") {
            """
                |    {
                |      "id": ${it.id.value.json()},
                |      "values": ${it.values.sorted().jsonArray()}
                |    }
            """.trimMargin()
        }

    private fun navigationArtifact(profile: GeneratedLinkArtifactRef): String {
        val binding = LinkNativeBindings.requireNavigationArtifact(profile)
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
        return """
            |      {
            |        "artifactRef": ${binding.artifact.wireId.json()},
            |        "entryPageRef": ${binding.entryPage.wireId.json()},
            |        "pages": [
            |$pages
            |        ]
            |      }
        """.trimMargin()
    }

    private fun activePageBindings(): String = LinkNativeBindings.activePageBindings.joinToString(",\n") {
        """
            |      {
            |        "publisherPortRef": ${it.publisher.id.value.json()},
            |        "pageHostPortRef": ${it.pageHost.id.value.json()}
            |      }
        """.trimMargin()
    }

    private fun actionGroups(profile: GeneratedLinkArtifactRef): String = LinkNativeBindings.actionGroups
        .filter { it.artifact == profile }
        .sortedBy { it.component.wireId }
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

    private fun GeneratedProductPortId.relativeTo(nodeId: String): String {
        val prefix = "$nodeId."
        require(value.startsWith(prefix))
        return value.removePrefix(prefix)
    }

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

    private fun Iterable<String>.jsonArray(): String = joinToString(", ", "[", "]") { it.json() }
}
