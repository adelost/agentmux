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

    @Test
    public void sessionCredentialsNormalizeAndPreserveIdentity() {
        LinkSessionCredentials credentials = new LinkSessionCredentials(
            "https://link.v1d.io/",
            " session-one ",
            " identity-one "
        );

        assertEquals("https://link.v1d.io", credentials.baseUrl());
        assertEquals("session-one", credentials.session());
        assertEquals("identity-one", credentials.identityId());
    }

    @Test
    public void eventPagePreservesMailboxTruthForBothHosts() {
        PublicLinkClient.EventsPage page = PublicLinkClient.parseEventsPage(
            """
            {
              "events": [{
                "seq": 7,
                "clientMessageId": "turn-seven",
                "target": "agent:7",
                "state": "replied",
                "body": "",
                "replyBody": "Klart",
                "createdAt": 70,
                "replyAt": 71
              }],
              "heartbeats": {"agent:7": true, "agent:8": false}
            }
            """
        );

        assertEquals(1, page.events.size());
        assertEquals("turn-seven", page.events.get(0).clientMessageId);
        assertEquals(70L, page.events.get(0).createdAtMs);
        assertEquals(71L, page.events.get(0).replyAtMs);
        assertEquals(Boolean.TRUE, page.heartbeats.get("agent:7"));
        assertEquals(Boolean.FALSE, page.heartbeats.get("agent:8"));
    }
}
