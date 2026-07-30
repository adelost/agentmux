package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ServerDiscoveryTest {
    @Test
    public void acceptsVersionedAgentmuxConfigurationOnTailnet() {
        ServerDiscovery.Configuration result = ServerDiscovery.parse(
            "https://relay.example.ts.net:8443/",
            "{\"service\":\"agentmux-audio-inbox\",\"schemaVersion\":2,"
                + "\"serverId\":\"abyss-wsl\",\"target\":\"1502949109491961917\","
                + "\"targets\":[{\"id\":\"lsrc:3\",\"label\":\"L-source 3\","
                + "\"kind\":\"agent\",\"agent\":\"lsrc\",\"pane\":3,"
                + "\"audioTarget\":\"1502949109491961917\"}]}"
        );

        assertEquals("https://relay.example.ts.net:8443", result.serverUrl);
        assertEquals("abyss-wsl", result.serverId);
        assertEquals("1502949109491961917", result.target);
        assertEquals(1, result.conversationTargets.size());
        assertEquals("lsrc:3", result.conversationTargets.get(0).id);
        assertEquals("L-source 3", result.conversationTargets.get(0).label);
        assertEquals(3, result.conversationTargets.get(0).pane);
    }

    @Test
    public void acceptsWindowsRescueAsASeparateFavorite() {
        ServerDiscovery.Configuration result = ServerDiscovery.parse(
            "http://100.115.225.24:8081",
            "{\"service\":\"agentmux-windows-manager-audio\",\"schemaVersion\":1,"
                + "\"serverId\":\"windows-host\","
                + "\"targets\":[{\"id\":\"manager\",\"label\":\"Rescue manager\"}]}"
        );

        assertEquals(1, result.conversationTargets.size());
        assertEquals(ConversationTarget.Kind.WINDOWS, result.conversationTargets.get(0).kind);
        assertEquals("manager", result.conversationTargets.get(0).id);
        assertEquals("Rescue manager", result.conversationTargets.get(0).label);
    }

    @Test
    public void rejectsWrongServiceSchemaOrTarget() {
        assertNull(ServerDiscovery.parse(
            "http://100.73.86.55:8080",
            "{\"service\":\"other\",\"schemaVersion\":1,\"serverId\":\"x\","
                + "\"target\":\"1502949109491961917\"}"
        ));
        assertNull(ServerDiscovery.parse(
            "http://100.73.86.55:8080",
            "{\"service\":\"agentmux-audio-inbox\",\"schemaVersion\":2,"
                + "\"serverId\":\"x\",\"target\":\"not-a-channel\"}"
        ));
    }

    @Test
    public void cleartextIsLimitedToTailnetOrPrivateNetwork() {
        assertTrue(ServerDiscovery.isAllowedServer("http://100.73.86.55:8080"));
        assertTrue(ServerDiscovery.isAllowedServer("http://192.168.1.10:8080"));
        assertTrue(ServerDiscovery.isAllowedServer("http://agentmux.local:8080"));
        assertFalse(ServerDiscovery.isAllowedServer("http://example.com:8080"));
        assertFalse(ServerDiscovery.isAllowedServer("ftp://100.73.86.55/file"));
        assertTrue(ServerDiscovery.isAllowedServer("https://example.com"));
    }

    @Test
    public void parsesMultipleAgentTargetsWithFriendlyLabels() {
        ServerDiscovery.Configuration result = ServerDiscovery.parse(
            "https://relay.example.ts.net:8443",
            "{\"service\":\"agentmux-audio-inbox\",\"schemaVersion\":2,"
                + "\"serverId\":\"abyss-wsl\",\"target\":\"1502949109491961917\","
                + "\"targets\":["
                + "{\"id\":\"lsrc:3\",\"label\":\"broker\",\"kind\":\"agent\",\"agent\":\"lsrc\",\"pane\":3,\"audioTarget\":\"1502949109491961917\"},"
                + "{\"id\":\"lsrc:10\",\"label\":\"worker\",\"kind\":\"agent\",\"agent\":\"lsrc\",\"pane\":10,\"audioTarget\":\"1528238682744557598\"}"
                + "]}"
        );
        assertEquals(2, result.conversationTargets.size());
        assertEquals("broker", result.conversationTargets.get(0).label);
        assertEquals("worker", result.conversationTargets.get(1).label);
        assertEquals(10, result.conversationTargets.get(1).pane);
        assertEquals("1528238682744557598", result.conversationTargets.get(1).audioTarget);
        assertEquals("lsrc", result.conversationTargets.get(1).agent);
    }

    @Test
    public void bootstrapUsesSavedThenPublishedThenGenericLocalRoutes() {
        assertEquals(
            java.util.List.of(
                "https://relay.example.ts.net:8443",
                "https://other.example.ts.net",
                "http://agentmux.local:8080"
            ),
            ServerDiscovery.bootstrapCandidates(
                "https://relay.example.ts.net:8443/",
                java.util.List.of(
                    "https://other.example.ts.net/",
                    "https://relay.example.ts.net:8443",
                    "http://example.com:8080"
                )
            )
        );
        assertEquals(
            java.util.List.of("http://agentmux.local:8080"),
            ServerDiscovery.bootstrapCandidates("http://example.com:8080", java.util.List.of())
        );
    }
}
