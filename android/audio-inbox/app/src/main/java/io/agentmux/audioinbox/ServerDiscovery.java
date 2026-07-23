package io.agentmux.audioinbox;

import org.json.JSONObject;
import org.json.JSONArray;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

final class ServerDiscovery {
    static final List<String> WSL_CANDIDATES = List.of(
        "https://abyss-wsl.tail13cb13.ts.net:8443",
        "http://agentmux.local:8080"
    );
    static final List<String> WINDOWS_CANDIDATES = List.of(
        "http://abyss-win.tail13cb13.ts.net:8081",
        "http://100.115.225.24:8081"
    );

    static final class Configuration {
        final String serverUrl;
        final String serverId;
        final String target;
        final List<ConversationTarget> conversationTargets;

        Configuration(
            String serverUrl,
            String serverId,
            String target,
            List<ConversationTarget> conversationTargets
        ) {
            this.serverUrl = serverUrl;
            this.serverId = serverId;
            this.target = target;
            this.conversationTargets = conversationTargets;
        }
    }

    private ServerDiscovery() {}

    static String displayLabelFor(String id, String serverLabel) {
        if ("lsrc:3".equals(id)) return "L-source 3";
        if ("lsrc:10".equals(id)) return "L-source 10";
        return serverLabel == null || serverLabel.isEmpty() ? id : serverLabel;
    }

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
            String service = json.optString("service");
            int schema = json.optInt("schemaVersion", 0);
            String serverId = json.optString("serverId", "").trim();
            if (serverId.isEmpty()) return null;
            if ("agentmux-windows-manager-audio".equals(service) && schema == 1) {
                ConversationTarget manager = new ConversationTarget(
                    "windows",
                    "Windows rescue",
                    ConversationTarget.Kind.WINDOWS,
                    serverUrl.replaceAll("/+$", ""),
                    null,
                    null,
                    -1
                );
                return new Configuration(manager.serverUrl, serverId, "", List.of(manager));
            }
            if (!"agentmux-audio-inbox".equals(service) || (schema != 1 && schema != 2)) return null;
            String target = json.optString("target", "").trim();
            if (!target.matches("^\\d{10,24}$")) return null;
            String normalized = serverUrl.replaceAll("/+$", "");
            List<ConversationTarget> targets = new ArrayList<>();
            if (schema == 2) {
                JSONArray rows = json.optJSONArray("targets");
                for (int index = 0; rows != null && index < rows.length(); index++) {
                    JSONObject row = rows.optJSONObject(index);
                    if (row == null || !"agent".equals(row.optString("kind"))) continue;
                    String id = row.optString("id", "").trim();
                    String label = row.optString("label", id).trim();
                    String agent = row.optString("agent", "").trim();
                    String audioTarget = row.optString("audioTarget", "").trim();
                    int pane = row.optInt("pane", -1);
                    if (!id.matches("^[A-Za-z0-9_.:@-]{1,80}$") || agent.isEmpty()
                        || pane < 0 || !audioTarget.matches("^\\d{10,24}$")) continue;
                    String displayLabel = displayLabelFor(id, label);
                    targets.add(new ConversationTarget(
                        id, displayLabel, ConversationTarget.Kind.AGENT,
                        normalized, audioTarget, agent, pane
                    ));
                }
            }
            return new Configuration(normalized, serverId, target, targets);
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
