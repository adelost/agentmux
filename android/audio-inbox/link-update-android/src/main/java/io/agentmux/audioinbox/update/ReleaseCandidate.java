package io.agentmux.audioinbox.update;

record ReleaseCandidate(
    int versionCode,
    String versionName,
    String apkUrl,
    long sizeBytes,
    String sha256,
    String changelog,
    long createdAtMs,
    long expiresAtMs
) {}
