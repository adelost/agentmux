package io.agentmux.audioinbox;

import java.net.URI;

/** Network boundary shared by mailbox catalogs and private discovery. */
public final class LinkUrlPolicy {
    private LinkUrlPolicy() {}

    public static boolean isAllowedServer(String value) {
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

    private static boolean isPrivateIpv4(String host) {
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        try {
            for (int index = 0; index < octets.length; index++) {
                octets[index] = Integer.parseInt(parts[index]);
                if (octets[index] < 0 || octets[index] > 255) return false;
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
}
