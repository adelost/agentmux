package io.agentmux.audioinbox;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.pm.PackageInstaller;

import org.junit.Test;

public class UpdateInstallReceiverTest {
    @Test
    public void pendingConfirmationAndSuccessAreNeverShownAsInstallerFailures() {
        assertFalse(UpdateInstallReceiver.isFailure(
            PackageInstaller.STATUS_PENDING_USER_ACTION
        ));
        assertFalse(UpdateInstallReceiver.isFailure(PackageInstaller.STATUS_SUCCESS));
        assertTrue(UpdateInstallReceiver.isFailure(PackageInstaller.STATUS_FAILURE));
        assertTrue(UpdateInstallReceiver.isFailure(
            PackageInstaller.STATUS_FAILURE_INVALID
        ));
    }
}
