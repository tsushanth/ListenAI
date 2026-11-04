package com.listenai.ui.privacy

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.window.DialogProperties
import com.listenai.BuildConfig
import com.listenai.R
import com.listenai.service.AnalyticsConsent
import com.listenai.service.ConsentState

/**
 * First-run (and once for existing installs) analytics choice. Shown only while the choice is unset.
 * Both buttons have equal weight. Nothing is collected before an answer.
 */
@Composable
fun AnalyticsConsentDialog() {
    if (BuildConfig.FLAVOR == "voice") return
    val manager = AnalyticsConsent.get() ?: return
    val state by manager.state.collectAsState()
    if (state != ConsentState.UNSET) return

    AlertDialog(
        onDismissRequest = {},
        properties = DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false),
        title = { Text(stringResource(R.string.analytics_consent_title)) },
        text = { Text(stringResource(R.string.analytics_consent_body)) },
        confirmButton = {
            TextButton(onClick = { manager.setGranted(true) }) {
                Text(stringResource(R.string.analytics_consent_allow))
            }
        },
        dismissButton = {
            TextButton(onClick = { manager.setGranted(false) }) {
                Text(stringResource(R.string.analytics_consent_decline))
            }
        }
    )
}
