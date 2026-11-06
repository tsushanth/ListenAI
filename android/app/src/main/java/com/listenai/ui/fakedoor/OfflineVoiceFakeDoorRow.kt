package com.listenai.ui.fakedoor

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.listenai.BuildConfig
import com.listenai.R
import com.listenai.service.AnalyticsConsent
import com.listenai.service.FirebaseAnalyticsHelper
import com.listenai.service.fakedoor.FakeDoorController
import com.listenai.service.fakedoor.FakeDoorEventSink
import com.listenai.service.fakedoor.FakeDoorRemoteFlag
import com.listenai.service.fakedoor.OfflineVoiceFakeDoor
import com.listenai.service.fakedoor.PrefsInterestStore
import com.listenai.ui.theme.Purple

/**
 * Settings row + honest explainer for the offline-voice fake door. Renders nothing unless
 * [OfflineVoiceFakeDoor.isVisible] (flag OFF by default; never in the voice flavor).
 */
@Composable
fun OfflineVoiceFakeDoorRow() {
    val context = LocalContext.current
    val visible = remember {
        OfflineVoiceFakeDoor.isVisible(
            buildFlag = BuildConfig.OFFLINE_VOICE_FAKE_DOOR,
            remoteFlag = FakeDoorRemoteFlag.isOn(context),
            isVoiceFlavor = BuildConfig.FLAVOR == "voice"
        )
    }
    if (!visible) return

    val controller = remember {
        FakeDoorController(
            store = PrefsInterestStore(context),
            analyticsGranted = { AnalyticsConsent.get()?.isGranted == true },
            sink = FakeDoorEventSink { FirebaseAnalyticsHelper.logSimpleEvent(it) }
        )
    }
    var showDialog by remember { mutableStateOf(false) }
    var interested by remember { mutableStateOf(controller.interested) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable {
                controller.onOpened()
                showDialog = true
            }
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(Purple.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(Icons.Default.RecordVoiceOver, contentDescription = null, tint = Purple, modifier = Modifier.size(20.dp))
        }
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                stringResource(R.string.fakedoor_title),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium
            )
            Text(
                stringResource(R.string.fakedoor_row_subtitle),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
    HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

    if (showDialog) {
        AlertDialog(
            onDismissRequest = { showDialog = false },
            title = { Text(stringResource(R.string.fakedoor_headline)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(stringResource(R.string.fakedoor_body), style = MaterialTheme.typography.bodyMedium)
                    Text(stringResource(R.string.fakedoor_no_payment), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                    Text(stringResource(R.string.fakedoor_price), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                    if (interested) {
                        Text(
                            stringResource(R.string.fakedoor_notify_done),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            },
            confirmButton = {
                if (interested) {
                    TextButton(onClick = {
                        controller.onWithdraw()
                        interested = false
                    }) { Text(stringResource(R.string.fakedoor_withdraw)) }
                } else {
                    TextButton(onClick = {
                        interested = controller.onNotifyMe()
                    }) { Text(stringResource(R.string.fakedoor_notify)) }
                }
            },
            dismissButton = {
                TextButton(onClick = { showDialog = false }) { Text(stringResource(R.string.fakedoor_close)) }
            }
        )
    }
}
