package io.agentmux.audioinbox;

import static org.junit.Assert.*;

import org.junit.Test;

import java.util.List;

public class MessageMediaTest {
    @Test
    public void imageUrlsExtractsOnlyImageLinks() {
        List<String> urls = MessageMedia.imageUrls(
            "Kolla här https://cdn.discordapp.com/a/b/skarm.PNG?x=1 och https://example.com/doc.pdf sen http://192.168.1.2:8080/bild.jpg"
        );
        assertEquals(2, urls.size());
        assertTrue(urls.get(0).endsWith("?x=1"));
        assertEquals("http://192.168.1.2:8080/bild.jpg", urls.get(1));
        assertTrue(MessageMedia.imageUrls("ingen bild här").isEmpty());
        assertTrue(MessageMedia.imageUrls(null).isEmpty());
    }

    @Test
    public void imageUrlsDedupesAndCapsAtFour() {
        String repeated = "https://x.se/a.png ".repeat(6);
        assertEquals(1, MessageMedia.imageUrls(repeated).size());
        String many = "https://x.se/1.png https://x.se/2.png https://x.se/3.png https://x.se/4.png https://x.se/5.png";
        assertEquals(4, MessageMedia.imageUrls(many).size());
    }

    @Test
    public void voiceKeyIsStableAndDistinct() {
        String first = MessageMedia.voiceKey("L-source 3", "hej");
        assertEquals(first, MessageMedia.voiceKey("L-source 3", "hej"));
        assertNotEquals(first, MessageMedia.voiceKey("L-source 3", "hej2"));
        assertNotEquals(first, MessageMedia.voiceKey("L-source 10", "hej"));
        assertTrue(first.startsWith("tts-"));
    }
}
