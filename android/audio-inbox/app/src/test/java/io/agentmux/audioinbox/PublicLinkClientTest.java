package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PublicLinkClientTest {
    @Test
    public void generatedVerifierIsBoundedAndNeverPlacedInTheAuthUrl() {
        String first = PublicLinkClient.generateVerifier();
        String second = PublicLinkClient.generateVerifier();

        assertTrue(first.matches("^[a-z]{48}$"));
        assertTrue(second.matches("^[a-z]{48}$"));
        assertNotEquals(first, second);
        String url = PublicLinkClient.authStartUrl(
            PublicLinkClient.DEFAULT_BASE + "/",
            "opaque-challenge"
        );
        assertEquals(
            "https://link.v1d.io/auth/start?client=android&challenge=opaque-challenge",
            url
        );
        assertTrue(!url.contains(first));
    }

    @Test
    public void pkceChallengeMatchesTheS256Contract() {
        assertEquals(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            PublicLinkClient.pkceChallenge(
                "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
            )
        );
    }

    @Test
    public void targetCatalogCarriesOnlyValidatedServerProvidedDiscoveryUrls() throws Exception {
        PublicLinkClient.TargetCatalog catalog = PublicLinkClient.parseTargetCatalog(
            "{\"targets\":[{\"id\":\"alpha:1\",\"label\":\"Alpha\",\"online\":true}],"
                + "\"privateDiscoveryUrls\":["
                + "\"https://relay.example.ts.net:8443/\","
                + "\"https://relay.example.ts.net:8443\","
                + "\"http://example.com:8080\"]}"
        );

        assertEquals(1, catalog.targets.size());
        assertEquals("alpha:1", catalog.targets.get(0).id);
        assertEquals(
            java.util.List.of("https://relay.example.ts.net:8443"),
            catalog.privateDiscoveryUrls
        );
    }
}
