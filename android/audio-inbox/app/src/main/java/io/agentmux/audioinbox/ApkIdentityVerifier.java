package io.agentmux.audioinbox;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;

import java.io.File;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;

/** Package/version/signer fence adapted from Skyvw releasekit. */
final class ApkIdentityVerifier {
    record Identity(String packageName, String versionName, long versionCode, Set<String> signers) {}

    private ApkIdentityVerifier() {}

    static String rejection(
        Context context,
        File apk,
        ReleaseCandidate candidate
    ) {
        Identity installed = installed(context);
        Identity archive = archive(context, apk);
        if (installed == null || archive == null) return "APK identity unavailable";
        return rejection(
            installed,
            archive,
            context.getPackageName(),
            BuildConfig.UPDATE_SIGNER_SHA256,
            candidate
        );
    }

    static String rejection(
        Identity installed,
        Identity archive,
        String expectedPackage,
        String pinnedSigner,
        ReleaseCandidate candidate
    ) {
        if (!installed.packageName().equals(expectedPackage)
            || !installed.signers().equals(Set.of(pinnedSigner))) return "installed signer mismatch";
        if (!archive.packageName().equals(expectedPackage)) return "package mismatch";
        if (!archive.versionName().equals(candidate.versionName())
            || archive.versionCode() != candidate.versionCode()) return "version metadata mismatch";
        if (archive.versionCode() <= installed.versionCode()) return "version is not newer";
        if (!archive.signers().equals(installed.signers())) return "signer mismatch";
        return null;
    }

    private static Identity installed(Context context) {
        try {
            return identity(context.getPackageManager().getPackageInfo(
                context.getPackageName(),
                packageFlags()
            ));
        } catch (Exception ignored) {
            return null;
        }
    }

    private static Identity archive(Context context, File apk) {
        PackageInfo info = context.getPackageManager().getPackageArchiveInfo(
            apk.getAbsolutePath(),
            packageFlags()
        );
        return info == null ? null : identity(info);
    }

    @SuppressWarnings("deprecation")
    private static int packageFlags() {
        return Build.VERSION.SDK_INT >= 28
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
    }

    @SuppressWarnings("deprecation")
    private static Identity identity(PackageInfo info) {
        Set<String> signers = new HashSet<>();
        Signature[] signatures = Build.VERSION.SDK_INT >= 28
            ? info.signingInfo.getApkContentsSigners()
            : info.signatures;
        if (signatures != null) {
            for (Signature signature : signatures) signers.add(sha256(signature.toByteArray()));
        }
        long versionCode = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        return new Identity(
            info.packageName,
            info.versionName == null ? "" : info.versionName,
            versionCode,
            signers
        );
    }

    private static String sha256(byte[] value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value);
            StringBuilder result = new StringBuilder();
            for (byte item : bytes) result.append(String.format("%02X", item));
            return result.toString();
        } catch (Exception error) {
            return "";
        }
    }
}
