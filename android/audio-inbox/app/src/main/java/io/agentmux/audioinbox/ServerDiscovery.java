package io.agentmux.audioinbox;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;

final class ServerDiscovery {
    static final List<String> DEFAULT_CANDIDATES = List.of(
        "http://abyss-wsl.tail13cb13.ts.net:8080",
        "http://100.73.86.55:8080",
        "http://agentmux.local:8080"
    );

    static final class Configuration {
        final String serverUrl;
        final String serverId;
        final String target;

        Configuration(String serverUrl, String serverId, String target) {
            this.serverUrl = serverUrl;
            this.serverId = serverId;
            this.target = target;
        }
    }

    private ServerDiscovery() {}

    static Configuration discover(List<String> candidates) {
        for (String candidate : candidates) {
            try {
                Configuration result = fetch(candidate);
                if (result != null) return result;
            } catch (Exception ignored) {
                // A candidate is only an observation. The next candidate may still be valid.
            }
        }
        return null;
    }

    static Configuration parse(String serverUrl, String body) {
        if (!isAllowedServer(serverUrl)) return null;
        try {
            JSONObject json = new JSONObject(body);
            if (!"agentmux-audio-inbox".equals(json.optString("service"))) return null;
            if (json.optInt("schemaVersion", 0) != 1) return null;
            String serverId = json.optString("serverId", "").trim();
            String target = json.optString("target", "").trim();
            if (serverId.isEmpty() || !target.matches("^\\d{10,24}$")) return null;
            return new Configuration(serverUrl.replaceAll("/+$", ""), serverId, target);
        } catch (Exception ignored) {
            return null;
        }
    }

    static boolean isAllowedServer(String value) {
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null || uri.getUserInfo() != null) return false;
            if ("https".equalsIgnoreCase(scheme)) return true;
            if (!"http".equalsIgnoreCase(scheme)) return false;
            String lower = host.toLowerCase();
            return lower.endsWith(".ts.net")
                || lower.endsWith(".local")
                || isPrivateIpv4(lower);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static Configuration fetch(String serverUrl) throws Exception {
        if (!isAllowedServer(serverUrl)) return null;
        HttpURLConnection connection = (HttpURLConnection) new URL(
            serverUrl.replaceAll("/+$", "") + "/api/audio/config"
        ).openConnection();
        try {
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", "application/json");
            connection.setConnectTimeout(2500);
            connection.setReadTimeout(2500);
            if (connection.getResponseCode() != 200) return null;
            try (InputStream input = connection.getInputStream()) {
                return parse(serverUrl, new String(
                    readBounded(input, 16 * 1024),
                    StandardCharsets.UTF_8
                ));
            }
        } finally {
            connection.disconnect();
        }
    }

    private static boolean isPrivateIpv4(String host) {
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        try {
            for (int i = 0; i < 4; i++) {
                octets[i] = Integer.parseInt(parts[i]);
                if (octets[i] < 0 || octets[i] > 255) return false;
            }
        } catch (NumberFormatException ignored) {
            return false;
        }
        return octets[0] == 10
            || octets[0] == 127
            || (octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127)
            || (octets[0] == 169 && octets[1] == 254)
            || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
            || (octets[0] == 192 && octets[1] == 168);
    }

    private static byte[] readBounded(InputStream input, int maxBytes) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[2048];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > maxBytes) {
                throw new IllegalStateException("discovery response is oversized");
            }
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }
}
