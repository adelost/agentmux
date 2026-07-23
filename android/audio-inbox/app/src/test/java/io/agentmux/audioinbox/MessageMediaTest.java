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

    @Test
    public void imageBudgetCountsRowsNotUniqueUrls() {
        java.util.List<String> texts = new java.util.ArrayList<>();
        for (int index = 0; index < 100; index++) {
            texts.add("svar https://x.se/samma.png");
        }
        java.util.Set<String> budget = MessageMedia.imageBudget(texts, 12);
        assertEquals("same URL in 100 rows still renders at most 12 rows", 12, budget.size());
        assertTrue("newest rows win the budget", budget.contains("99|https://x.se/samma.png"));
        assertFalse(budget.contains("0|https://x.se/samma.png"));
    }

    @Test
    public void sampleSizeKeepsDecodedPixelsAndWidthUnderBudget() {
        int sample = MessageMedia.sampleSize(10000, 10000, 280, 4_000_000);
        long pixels = (10000L / sample) * (10000L / sample);
        assertTrue("10000x10000 decodes under 4M pixels", pixels <= 4_000_000);
        assertTrue("and under the target width", 10000 / sample <= 280);
        assertEquals(4, MessageMedia.sampleSize(600, 400, 280, 4_000_000));
        int screenshot = MessageMedia.sampleSize(1080, 2400, 280, 4_000_000);
        assertTrue(1080 / screenshot <= 280);
    }
}
