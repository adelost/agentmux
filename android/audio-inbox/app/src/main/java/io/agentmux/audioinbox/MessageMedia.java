package io.agentmux.audioinbox;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Pure message helpers: image link extraction and stable voice keys. */
final class MessageMedia {
    private static final Pattern IMAGE_URL = Pattern.compile(
        "https?://\\S+?\\.(?:png|jpe?g|gif|webp)(?:\\?\\S*)?",
        Pattern.CASE_INSENSITIVE
    );
    static final int MAX_IMAGE_BYTES = 8 * 1024 * 1024;

    private MessageMedia() {}

    static List<String> imageUrls(String text) {
        List<String> urls = new ArrayList<>();
        if (text == null) return urls;
        Matcher matcher = IMAGE_URL.matcher(text);
        while (matcher.find() && urls.size() < 4) {
            String url = matcher.group();
            if (!urls.contains(url)) urls.add(url);
        }
        return urls;
    }

    static String voiceKey(String target, String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(
                (target + "|" + (text == null ? "" : text)).getBytes(StandardCharsets.UTF_8)
            );
            StringBuilder key = new StringBuilder("tts-");
            for (int index = 0; index < 12; index++) {
                key.append(String.format("%02x", hash[index]));
            }
            return key.toString();
        } catch (Exception impossible) {
            return "tts-" + Integer.toHexString((target + "|" + text).hashCode());
        }
    }
}
