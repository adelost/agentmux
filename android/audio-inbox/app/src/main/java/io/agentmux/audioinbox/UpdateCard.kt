package io.agentmux.audioinbox

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.agentmux.linkcore.UpdatePresentation

@Composable
internal fun UpdateCard(
    update: UpdatePresentation,
    onInstall: () -> Unit,
    onRetry: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = LinkTokens.Surface,
        border = BorderStroke(1.dp, LinkTokens.Border),
    ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.fillMaxWidth().padding(14.dp),
        ) {
            Text("Updates", fontWeight = FontWeight.SemiBold)
            Text("Current ${update.currentVersion.ifBlank { "unknown" }}", color = LinkTokens.Muted)
            if (update.availableVersion.isNotBlank()) {
                Text("Available ${update.availableVersion}", color = LinkTokens.Accent)
            }
            Text(update.detail.ifBlank { update.state }, color = updateColor(update.state))
            if (update.changelog.isNotBlank()) Text(update.changelog, color = LinkTokens.Ink)
            if (update.state == "downloading") {
                LinearProgressIndicator(
                    progress = { update.progress.coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (update.canInstall) Button(onClick = onInstall) { Text("Install") }
                if (update.canRetry) OutlinedButton(onClick = onRetry) { Text("Retry") }
            }
        }
    }
}

private fun updateColor(state: String) = when (state) {
    "failed" -> LinkTokens.Error
    "checking", "downloading", "installing" -> LinkTokens.Warning
    else -> LinkTokens.Accent
}
