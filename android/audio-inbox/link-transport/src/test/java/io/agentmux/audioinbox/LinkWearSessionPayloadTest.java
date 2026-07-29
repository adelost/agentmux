package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Map;
import org.junit.Test;

public class LinkWearSessionPayloadTest {
    @Test
    public void activeCredentialsRoundTripWithoutInventingIdentity() {
        LinkWearSessionPayload decoded = LinkWearSessionPayload.decode(
            LinkWearSessionPayload.active(
                new LinkSessionCredentials(
                    PublicLinkClient.DEFAULT_BASE,
                    "session-one",
                    "identity-one"
                ),
                42L
            ).encode()
        );

        assertEquals("session-one", decoded.credentials().session());
        assertEquals("identity-one", decoded.credentials().identityId());
        assertEquals(42L, decoded.changedAtMs());
    }

    @Test
    public void revokeRoundTripsWithoutBearerMaterial() {
        Map<String, String> encoded = LinkWearSessionPayload.revoked(43L).encode();

        assertNull(encoded.get(LinkWearSessionPayload.KEY_SESSION));
        assertTrue(LinkWearSessionPayload.decode(encoded).revoked());
    }

    @Test
    public void malformedOrUnknownPayloadFailsClosed() {
        assertNull(LinkWearSessionPayload.decode(Map.of()));
        assertNull(LinkWearSessionPayload.decode(Map.of(
            LinkWearSessionPayload.KEY_VERSION, "2",
            LinkWearSessionPayload.KEY_CHANGED_AT_MS, "44"
        )));
    }
}
