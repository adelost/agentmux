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
            "http://abyss-wsl.tail13cb13.ts.net:8080/",
            "{\"service\":\"agentmux-audio-inbox\",\"schemaVersion\":2,"
                + "\"serverId\":\"abyss-wsl\",\"target\":\"1502949109491961917\","
                + "\"targets\":[{\"id\":\"lsrc:3\",\"label\":\"L-source 3\","
                + "\"kind\":\"agent\",\"agent\":\"lsrc\",\"pane\":3,"
                + "\"audioTarget\":\"1502949109491961917\"}]}"
        );

        assertEquals("http://abyss-wsl.tail13cb13.ts.net:8080", result.serverUrl);
        assertEquals("abyss-wsl", result.serverId);
        assertEquals("1502949109491961917", result.target);
        assertEquals(1, result.conversationTargets.size());
        assertEquals("lsrc:3", result.conversationTargets.get(0).id);
        assertEquals(3, result.conversationTargets.get(0).pane);
    }

    @Test
    public void acceptsWindowsRescueAsASeparateFavorite() {
        ServerDiscovery.Configuration result = ServerDiscovery.parse(
            "http://100.115.225.24:8081",
            "{\"service\":\"agentmux-windows-manager-audio\",\"schemaVersion\":1,"
                + "\"serverId\":\"abyss-windows\"}"
        );

        assertEquals(1, result.conversationTargets.size());
        assertEquals(ConversationTarget.Kind.WINDOWS, result.conversationTargets.get(0).kind);
        assertEquals("windows", result.conversationTargets.get(0).id);
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
}
