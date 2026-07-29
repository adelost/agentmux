package io.agentmux.audioinbox

import android.content.Context
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable

/** Phone-owned producer for the single durable Wear mailbox session item. */
internal class LinkWearSessionPublisher(context: Context) {
    private val dataClient = Wearable.getDataClient(context.applicationContext)

    fun publish(credentials: LinkSessionCredentials) {
        put(LinkWearSessionPayload.active(credentials, System.currentTimeMillis()))
    }

    fun revoke() {
        put(LinkWearSessionPayload.revoked(System.currentTimeMillis()))
    }

    private fun put(payload: LinkWearSessionPayload) {
        val request = PutDataMapRequest.create(LinkWearSessionPayload.PATH)
        payload.encode().forEach(request.dataMap::putString)
        dataClient.putDataItem(request.asPutDataRequest().setUrgent())
    }
}
