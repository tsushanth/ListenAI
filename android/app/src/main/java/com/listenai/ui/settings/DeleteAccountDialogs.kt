package com.listenai.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.listenai.R
import com.listenai.service.account.AccountDeletionFailure
import com.listenai.ui.theme.Red

/** The dialogs of Settings > Delete account, one per [DeleteAccountState]. Pure UI: all decisions live in the view model. */
@Composable
fun DeleteAccountDialogs(
    state: DeleteAccountState,
    onConfirm: () -> Unit,
    onConfirmWithSubscription: () -> Unit,
    onRetry: () -> Unit,
    onDismiss: () -> Unit,
    onOpenPlay: () -> Unit
) {
    when (state) {
        DeleteAccountState.Idle -> Unit

        is DeleteAccountState.Confirming -> AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(stringResource(R.string.delete_account_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.delete_account_body))
                    if (state.playSubscriptionActive) Text(stringResource(R.string.delete_account_play_note))
                }
            },
            confirmButton = {
                TextButton(onClick = onConfirm) { Text(stringResource(R.string.delete_account_confirm), color = Red) }
            },
            dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } }
        )

        DeleteAccountState.Deleting -> AlertDialog(
            // Not dismissable: the request is in flight.
            onDismissRequest = {},
            title = { Text(stringResource(R.string.delete_account_deleting)) },
            text = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp))
                    Spacer(Modifier.width(16.dp))
                    Text(stringResource(R.string.delete_account_deleting), style = MaterialTheme.typography.bodyMedium)
                }
            },
            confirmButton = {}
        )

        is DeleteAccountState.SubscriptionWarning -> AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(stringResource(R.string.delete_account_subscription_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.delete_account_subscription_body))
                    if (state.subscriptions.play) Text(stringResource(R.string.delete_account_subscription_play))
                    if (state.subscriptions.stripe) Text(stringResource(R.string.delete_account_subscription_stripe))
                    if (state.subscriptions.play) {
                        TextButton(onClick = onOpenPlay) { Text(stringResource(R.string.delete_account_open_play)) }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = onConfirmWithSubscription) { Text(stringResource(R.string.delete_account_anyway), color = Red) }
            },
            dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } }
        )

        is DeleteAccountState.Error -> AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(stringResource(R.string.delete_account_error_title)) },
            text = {
                Text(
                    stringResource(
                        when (state.failure) {
                            AccountDeletionFailure.NETWORK -> R.string.delete_account_error_network
                            AccountDeletionFailure.SERVER -> R.string.delete_account_error_server
                            AccountDeletionFailure.SIGN_IN_REQUIRED -> R.string.delete_account_error_signin
                            AccountDeletionFailure.UNKNOWN -> R.string.delete_account_error_unknown
                        }
                    )
                )
            },
            confirmButton = {
                if (state.retryable) TextButton(onClick = onRetry) { Text(stringResource(R.string.retry)) }
                else TextButton(onClick = onDismiss) { Text(stringResource(R.string.close)) }
            },
            dismissButton = if (state.retryable) {
                { TextButton(onClick = onDismiss) { Text(stringResource(R.string.close)) } }
            } else null
        )

        is DeleteAccountState.Deleted -> AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(stringResource(R.string.delete_account_done_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.delete_account_done_body))
                    if (state.playSubscriptionStillActive) Text(stringResource(R.string.delete_account_done_play))
                    if (state.stripeSubscriptionStillActive) Text(stringResource(R.string.delete_account_done_stripe))
                }
            },
            confirmButton = {
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.done)) }
            },
            dismissButton = if (state.playSubscriptionStillActive) {
                { TextButton(onClick = onOpenPlay) { Text(stringResource(R.string.delete_account_open_play)) } }
            } else null
        )
    }
}
