package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;

import org.json.JSONObject;
import org.junit.Test;

public class AudioInboxHttpClientTest {
    @Test
    public void nullServerFieldsNeverOverwriteTheVisibleUserDraft() throws Exception {
        JSONObject response = new JSONObject()
            .put("sent", JSONObject.NULL)
            .put("transcript", " null ");

        assertEquals("", AudioInboxHttpClient.jsonText(response, "sent"));
        assertEquals("", AudioInboxHttpClient.jsonText(response, "transcript"));
        assertEquals("", AudioInboxHttpClient.jsonText(response, "missing"));
        assertEquals("Hej", AudioInboxHttpClient.jsonText(
            new JSONObject().put("sent", " Hej "),
            "sent"
        ));
    }
}
