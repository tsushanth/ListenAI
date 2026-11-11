package com.listenai.ui.settings

import com.listenai.service.account.AccountDeletionClient
import com.listenai.service.account.AccountDeletionException
import com.listenai.service.account.AccountDeletionFailure
import com.listenai.service.account.DeleteAccountResult
import com.listenai.service.account.SubscriptionFlags
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DeleteAccountViewModelTest {

    private class FakeClient : AccountDeletionClient {
        val results = ArrayDeque<() -> DeleteAccountResult>()
        val acks = mutableListOf<Boolean>()
        override suspend fun deleteAccount(acknowledgeActiveSubscription: Boolean): DeleteAccountResult {
            acks += acknowledgeActiveSubscription
            return results.removeFirst().invoke()
        }
    }

    private class FakeCleaner(var fail: Boolean = false) : LocalAccountCleaner {
        var calls = 0
        override suspend fun clear() {
            calls++
            if (fail) throw IllegalStateException("keystore")
        }
    }

    private val client = FakeClient()
    private val cleaner = FakeCleaner()
    private var play = false

    private fun TestScope.vm() = DeleteAccountViewModel(client, cleaner, { play }, scopeOverride = this)

    private val none = SubscriptionFlags(stripe = false, play = false)
    private fun ok(flags: SubscriptionFlags = none) = { DeleteAccountResult.Deleted(flags) }
    private fun fail(f: AccountDeletionFailure) = { throw AccountDeletionException(f) }

    @Test
    fun `nothing is sent until the user confirms`() = runTest(UnconfinedTestDispatcher()) {
        val vm = vm()
        assertEquals(DeleteAccountState.Idle, vm.state.value)
        vm.request()
        assertEquals(DeleteAccountState.Confirming(playSubscriptionActive = false), vm.state.value)
        assertTrue(client.acks.isEmpty())
        vm.dismiss()
        assertEquals(DeleteAccountState.Idle, vm.state.value)
        assertTrue(client.acks.isEmpty())
        assertEquals(0, cleaner.calls)
    }

    @Test
    fun `confirm without a prior request does nothing`() = runTest(UnconfinedTestDispatcher()) {
        val vm = vm()
        vm.confirm()
        vm.confirmWithActiveSubscription()
        assertTrue(client.acks.isEmpty())
        assertEquals(DeleteAccountState.Idle, vm.state.value)
    }

    @Test
    fun `the first dialog warns about Play when the app knows the user is subscribed`() = runTest(UnconfinedTestDispatcher()) {
        play = true
        val vm = vm()
        vm.request()
        assertEquals(DeleteAccountState.Confirming(playSubscriptionActive = true), vm.state.value)
    }

    @Test
    fun `success signs out and clears local data once, then reports Deleted`() = runTest(UnconfinedTestDispatcher()) {
        client.results += ok()
        val vm = vm()
        vm.request(); vm.confirm()
        assertEquals(listOf(false), client.acks)
        assertEquals(1, cleaner.calls)
        assertEquals(DeleteAccountState.Deleted(playSubscriptionStillActive = false, stripeSubscriptionStillActive = false), vm.state.value)
    }

    @Test
    fun `an active subscription asks again, sends the acknowledgement, and only then deletes`() = runTest(UnconfinedTestDispatcher()) {
        client.results += { DeleteAccountResult.ActiveSubscription(SubscriptionFlags(stripe = true, play = false)) }
        client.results += ok(SubscriptionFlags(stripe = true, play = false))
        val vm = vm()
        vm.request(); vm.confirm()
        assertEquals(DeleteAccountState.SubscriptionWarning(SubscriptionFlags(stripe = true, play = false)), vm.state.value)
        assertEquals("nothing cleared before the server deleted", 0, cleaner.calls)
        vm.confirmWithActiveSubscription()
        assertEquals(listOf(false, true), client.acks)
        assertEquals(1, cleaner.calls)
        assertEquals(DeleteAccountState.Deleted(playSubscriptionStillActive = false, stripeSubscriptionStillActive = true), vm.state.value)
    }

    @Test
    fun `cancelling the subscription warning deletes nothing`() = runTest(UnconfinedTestDispatcher()) {
        client.results += { DeleteAccountResult.ActiveSubscription(SubscriptionFlags(stripe = false, play = true)) }
        val vm = vm()
        vm.request(); vm.confirm(); vm.dismiss()
        assertEquals(DeleteAccountState.Idle, vm.state.value)
        assertEquals(listOf(false), client.acks)
        assertEquals(0, cleaner.calls)
    }

    @Test
    fun `local Play entitlement is folded into the warning and the final reminder`() = runTest(UnconfinedTestDispatcher()) {
        play = true
        client.results += { DeleteAccountResult.ActiveSubscription(SubscriptionFlags(stripe = true, play = false)) }
        client.results += ok(none)
        val vm = vm()
        vm.request(); vm.confirm()
        assertEquals(DeleteAccountState.SubscriptionWarning(SubscriptionFlags(stripe = true, play = true)), vm.state.value)
        vm.confirmWithActiveSubscription()
        assertEquals(DeleteAccountState.Deleted(playSubscriptionStillActive = true, stripeSubscriptionStillActive = false), vm.state.value)
    }

    @Test
    fun `a network failure keeps the session, offers retry, and retry succeeds`() = runTest(UnconfinedTestDispatcher()) {
        client.results += fail(AccountDeletionFailure.NETWORK)
        client.results += ok()
        val vm = vm()
        vm.request(); vm.confirm()
        assertEquals(DeleteAccountState.Error(AccountDeletionFailure.NETWORK, retryable = true, acknowledged = false), vm.state.value)
        assertEquals("a failed request must not sign the user out", 0, cleaner.calls)
        vm.retry()
        assertEquals(listOf(false, false), client.acks)
        assertEquals(1, cleaner.calls)
        assertTrue(vm.state.value is DeleteAccountState.Deleted)
    }

    @Test
    fun `a server failure is retryable and retry repeats the same acknowledgement level`() = runTest(UnconfinedTestDispatcher()) {
        client.results += { DeleteAccountResult.ActiveSubscription(SubscriptionFlags(stripe = true, play = false)) }
        client.results += fail(AccountDeletionFailure.SERVER)
        client.results += ok(SubscriptionFlags(stripe = true, play = false))
        val vm = vm()
        vm.request(); vm.confirm(); vm.confirmWithActiveSubscription()
        assertEquals(DeleteAccountState.Error(AccountDeletionFailure.SERVER, retryable = true, acknowledged = true), vm.state.value)
        vm.retry()
        assertEquals(listOf(false, true, true), client.acks)
        assertTrue(vm.state.value is DeleteAccountState.Deleted)
        assertEquals(1, cleaner.calls)
    }

    @Test
    fun `401 ends the local session but is not retryable`() = runTest(UnconfinedTestDispatcher()) {
        client.results += fail(AccountDeletionFailure.SIGN_IN_REQUIRED)
        val vm = vm()
        vm.request(); vm.confirm()
        assertEquals(DeleteAccountState.Error(AccountDeletionFailure.SIGN_IN_REQUIRED, retryable = false, acknowledged = false), vm.state.value)
        assertEquals(1, cleaner.calls)
        vm.retry()
        assertEquals("not retryable: no second request", 1, client.acks.size)
    }

    @Test
    fun `a failing local cleanup does not turn a finished server deletion into an error`() = runTest(UnconfinedTestDispatcher()) {
        cleaner.fail = true
        client.results += ok()
        val vm = vm()
        vm.request(); vm.confirm()
        assertTrue(vm.state.value is DeleteAccountState.Deleted)
    }

    @Test
    fun `an unexpected exception is a retryable unknown error and keeps the session`() = runTest(UnconfinedTestDispatcher()) {
        client.results += { throw IllegalStateException("boom") }
        val vm = vm()
        vm.request(); vm.confirm()
        assertEquals(DeleteAccountState.Error(AccountDeletionFailure.UNKNOWN, retryable = true, acknowledged = false), vm.state.value)
        assertEquals(0, cleaner.calls)
    }

    @Test
    fun `dismissing the result returns to idle`() = runTest(UnconfinedTestDispatcher()) {
        client.results += ok()
        val vm = vm()
        vm.request(); vm.confirm(); vm.dismiss()
        assertEquals(DeleteAccountState.Idle, vm.state.value)
    }
}
