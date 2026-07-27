package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.nio.file.Files;
import java.util.concurrent.atomic.AtomicReference;

public class PublicConversationTransportTest {
    @Test
    public void windowsVoiceUsesTheWireTargetAndKeepsTheVisibleResponder()
        throws Exception {
        AtomicReference<String> wireTarget = new AtomicReference<>();
        PublicConversationTransport.Client client = new PublicConversationTransport.Client() {
            public String send(String id, String target, String text) {
                throw new AssertionError("voice must not use text send");
            }
            public String sendVoice(String id, String target, File audio) {
                wireTarget.set(target);
                return "queued";
            }
            public String awaitReply(String id, long timeoutMs) {
                assertEquals(PublicConversationTransport.REPLY_TIMEOUT_MS, timeoutMs);
                return "Windows svar";
            }
        };
        PublicConversationTransport transport = new PublicConversationTransport(client);
        ConversationTarget target =
            ConversationTarget.publicLink("_windows_", "Windows rescue", true);
        File audio = Files.createTempFile("public-link-voice", ".m4a").toFile();
        Files.write(audio.toPath(), new byte[] { 1, 2, 3 });

        ConversationTransport.Accepted accepted =
            transport.durableAccept("turn-1", target, null, audio);
        ConversationTransport.Reply reply =
            transport.awaitReply("turn-1", target, accepted);

        assertTrue(transport.supports(target));
        assertEquals("windows", wireTarget.get());
        assertEquals("Voice message", accepted.visibleText());
        assertEquals("_windows_", reply.respondingTarget());
        assertEquals("Windows svar", reply.text());
        audio.delete();
    }
}
