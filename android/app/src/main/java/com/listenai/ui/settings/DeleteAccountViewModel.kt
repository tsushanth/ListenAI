package com.listenai.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.listenai.service.account.AccountDeletionClient
import com.listenai.service.account.AccountDeletionException
import com.listenai.service.account.AccountDeletionFailure
import com.listenai.service.account.DeleteAccountResult
import com.listenai.service.account.SubscriptionFlags
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Ends the local session and wipes what the app stored for the account. Must not throw for "nothing to clear". */
fun interface LocalAccountCleaner {
    suspend fun clear()
}

sealed class DeleteAccountState {
    object Idle : DeleteAccountState()

    /** First dialog. [playSubscriptionActive] is the app's own entitlement (Play), known before asking the server. */
    data class Confirming(val playSubscriptionActive: Boolean) : DeleteAccountState()

    object Deleting : DeleteAccountState()

    /** The server refused because a subscription is active; second, explicit confirmation. */
    data class SubscriptionWarning(val subscriptions: SubscriptionFlags) : DeleteAccountState()

    /** Failed and nothing was lost; [retryable] means the same button can simply be pressed again. */
    data class Error(val failure: AccountDeletionFailure, val retryable: Boolean, val acknowledged: Boolean) : DeleteAccountState()

    /** Done. The session and local account data are already gone. [playSubscriptionStillActive]: remind the user to cancel in Play. */
    data class Deleted(val playSubscriptionStillActive: Boolean, val stripeSubscriptionStillActive: Boolean) : DeleteAccountState()
}

/**
 * Settings > Delete account.
 *
 *   request()  -> Confirming
 *   confirm()  -> Deleting -> Deleted | SubscriptionWarning (server 409) | Error
 *   confirmWithActiveSubscription() -> same request with the acknowledgement
 *
 * The local session is only cleared after the server confirmed the deletion (or answered 401, which means the
 * session is already unusable). A failed request never signs the user out, so they can retry.
 */
class DeleteAccountViewModel(
    private val client: AccountDeletionClient,
    private val cleaner: LocalAccountCleaner,
    /** The app's own Play entitlement (RevenueCat), read when the dialog opens. */
    private val playSubscriptionActive: () -> Boolean = { false },
    scopeOverride: CoroutineScope? = null
) : ViewModel() {

    private val scope: CoroutineScope = scopeOverride ?: viewModelScope
    private val _state = MutableStateFlow<DeleteAccountState>(DeleteAccountState.Idle)
    val state: StateFlow<DeleteAccountState> = _state.asStateFlow()

    fun request() {
        if (_state.value is DeleteAccountState.Idle || _state.value is DeleteAccountState.Error) {
            _state.value = DeleteAccountState.Confirming(playSubscriptionActive())
        }
    }

    /** Cancel / dismiss. Ignored while the request is in flight so it cannot be abandoned half-way unseen. */
    fun dismiss() {
        when (_state.value) {
            is DeleteAccountState.Deleting -> Unit
            else -> _state.value = DeleteAccountState.Idle
        }
    }

    fun confirm() {
        if (_state.value !is DeleteAccountState.Confirming) return
        run(acknowledge = false)
    }

    fun confirmWithActiveSubscription() {
        if (_state.value !is DeleteAccountState.SubscriptionWarning) return
        run(acknowledge = true)
    }

    /** Retry after an [DeleteAccountState.Error], repeating the same acknowledgement level. */
    fun retry() {
        val s = _state.value as? DeleteAccountState.Error ?: return
        if (!s.retryable) return
        run(acknowledge = s.acknowledged)
    }

    private fun run(acknowledge: Boolean) {
        _state.value = DeleteAccountState.Deleting
        scope.launch {
            try {
                when (val r = client.deleteAccount(acknowledge)) {
                    is DeleteAccountResult.ActiveSubscription ->
                        _state.value = DeleteAccountState.SubscriptionWarning(r.subscriptions.copy(play = r.subscriptions.play || playSubscriptionActive()))
                    is DeleteAccountResult.Deleted -> {
                        cleanLocally()
                        _state.value = DeleteAccountState.Deleted(
                            playSubscriptionStillActive = r.subscriptions.play || playSubscriptionActive(),
                            stripeSubscriptionStillActive = r.subscriptions.stripe
                        )
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: AccountDeletionException) {
                if (e.failure == AccountDeletionFailure.SIGN_IN_REQUIRED) {
                    // The session is already unusable (expired, or the account is already gone): end it locally too.
                    cleanLocally()
                    _state.value = DeleteAccountState.Error(e.failure, retryable = false, acknowledged = acknowledge)
                } else {
                    _state.value = DeleteAccountState.Error(e.failure, retryable = true, acknowledged = acknowledge)
                }
            } catch (e: Exception) {
                _state.value = DeleteAccountState.Error(AccountDeletionFailure.UNKNOWN, retryable = true, acknowledged = acknowledge)
            }
        }
    }

    private suspend fun cleanLocally() {
        try {
            cleaner.clear()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The server side is already done; a local cleanup hiccup must not turn that into a failure.
        }
    }
}
