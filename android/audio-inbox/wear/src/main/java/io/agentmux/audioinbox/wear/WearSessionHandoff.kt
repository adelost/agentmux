package io.agentmux.audioinbox.wear

import android.content.Context
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import io.agentmux.audioinbox.KeystoreSessionStore
import io.agentmux.audioinbox.LinkSessionStore
import io.agentmux.audioinbox.LinkWearSessionPayload

internal enum class HandoffResult {
    STORED,
    REVOKED,
    REFUSED,
}

internal class WearSessionHandoffConsumer(
    private val store: LinkSessionStore,
) {
    fun accept(values: Map<String, String>): HandoffResult {
        val payload = LinkWearSessionPayload.decode(values) ?: return HandoffResult.REFUSED
        if (payload.revoked()) {
            store.clear()
            return HandoffResult.REVOKED
        }
        return if (store.replaceSession(payload.credentials())) {
            HandoffResult.STORED
        } else {
            HandoffResult.REFUSED
        }
    }
}

class WearSessionListenerService : WearableListenerService() {
    override fun onDataChanged(events: DataEventBuffer) {
        val consumer = WearSessionHandoffConsumer(sessionStore(this))
        events.forEach { event ->
            if (event.type == DataEvent.TYPE_CHANGED &&
                event.dataItem.uri.path == LinkWearSessionPayload.PATH
            ) {
                consumer.accept(DataMapItem.fromDataItem(event.dataItem).dataMap.stringValues())
            }
        }
    }
}

internal object WearSessionBootstrap {
    fun refresh(context: Context, onComplete: (HandoffResult?) -> Unit) {
        Wearable.getDataClient(context.applicationContext)
            .dataItems
            .addOnSuccessListener { items ->
                val consumer = WearSessionHandoffConsumer(sessionStore(context))
                val item = (0 until items.count)
                    .map(items::get)
                    .firstOrNull { it.uri.path == LinkWearSessionPayload.PATH }
                val result = item?.let {
                    consumer.accept(DataMapItem.fromDataItem(it).dataMap.stringValues())
                }
                items.release()
                onComplete(result)
            }
            .addOnFailureListener { onComplete(HandoffResult.REFUSED) }
    }
}

private fun sessionStore(context: Context): KeystoreSessionStore =
    KeystoreSessionStore(
        context.getSharedPreferences("link-wear-session", Context.MODE_PRIVATE),
    )

private fun com.google.android.gms.wearable.DataMap.stringValues(): Map<String, String> =
    keySet().associateWith { key -> getString(key).orEmpty() }
