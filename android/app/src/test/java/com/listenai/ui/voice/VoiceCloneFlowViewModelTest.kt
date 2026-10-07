package com.listenai.ui.voice

import com.listenai.service.auth.GoTrueErrorKind
import com.listenai.service.auth.GoTrueException
import com.listenai.service.auth.GoogleBrowserAuth
import com.listenai.service.auth.GoogleSignInErrorKind
import com.listenai.service.auth.GoogleSignInException
import com.listenai.service.auth.SupabaseGoTrueClient
import com.listenai.service.auth.SignUpResult
import com.listenai.service.voice.AudioClip
import com.listenai.service.voice.ClonedVoice
import com.listenai.service.voice.ConsentChallenge
import com.listenai.service.voice.Recovery
import com.listenai.service.voice.VoiceCloneClient
import com.listenai.service.voice.VoiceCloneException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.TestScope
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceCloneFlowViewModelTest {

    private class FakeClient : VoiceCloneClient {
        var challengeResults = ArrayDeque<() -> ConsentChallenge>()
        var createResults = ArrayDeque<() -> ClonedVoice>()
        var challengeCalls = 0
        var createCalls = 0
        var lastCreate: List<String> = emptyList()

        override suspend fun requestConsentChallenge(): ConsentChallenge {
            challengeCalls++
            return challengeResults.removeFirst().invoke()
        }

        override suspend fun createVoice(challengeId: String, name: String, language: String, consent: AudioClip, reference: AudioClip): ClonedVoice {
            createCalls++
            lastCreate = listOf(challengeId, name, language, consent.filename, reference.filename)
            return createResults.removeFirst().invoke()
        }

        override suspend fun listVoices() = emptyList<ClonedVoice>()
        override suspend fun deleteVoice(voiceId: String) {}
    }

    private var now = 1_000_000L
    private val client = FakeClient()
    private val created = mutableListOf<ClonedVoice>()

    private fun TestScope.vm(signedIn: Boolean = true) = VoiceCloneFlowViewModel(
        client = client,
        initialSignedIn = signedIn,
        clock = { now },
        scopeOverride = this,
        onCreated = { created += it }
    )

    private fun challenge(id: String, ttlMs: Long = 300_000) =
        ConsentChallenge(id, "phrase $id", "iso", now + ttlMs)

    private fun voice() = ClonedVoice("v-1", "Mine", "en", "active", null)
    private fun clip(name: String, sec: Int) = AudioClip(name, "audio/mp4", sec) { ByteArray(2048) }
    private fun err(status: Int, code: String, details: String? = null) =
        VoiceCloneException(status, code, "msg", details?.let { JSONObject(it) })

    /** Drives the happy path up to the REFERENCE step with a consent clip. */
    private fun VoiceCloneFlowViewModel.toReference() {
        agreeAndContinue()
        setName("Mine")
        continueFromProfile()
        setConsentClip(clip("consent.m4a", 6))
        continueFromConsent()
    }

    private val scopeDispatcher get() = UnconfinedTestDispatcher()

    @Test
    fun `happy path creates a voice with the right arguments`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm()
        client.challengeResults += { challenge("c1") }
        client.createResults += { voice() }

        vm.toReference()
        assertEquals(CloneStep.REFERENCE, vm.state.value.step)
        assertEquals("c1", vm.state.value.challenge?.challengeId)
        vm.setReferenceClip(clip("reference.m4a", 45))
        vm.submit()

        assertEquals(CloneStep.SUCCESS, vm.state.value.step)
        assertEquals(listOf("c1", "Mine", "en", "consent.m4a", "reference.m4a"), client.lastCreate)
        assertEquals(listOf("v-1"), created.map { it.id })
    }

    @Test
    fun `signed-out user is sent to the sign-in page, and a successful sign-in continues to the profile step`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm(signedIn = false)
        assertEquals(CloneStep.INTRO, vm.state.value.step)
        vm.agreeAndContinue()                                   // "Next" on the intro
        assertEquals(CloneStep.SIGN_IN, vm.state.value.step)
        assertFalse(vm.state.value.signedIn)

        vm.signIn { Result.success(Unit) }
        assertTrue(vm.state.value.signedIn)
        assertEquals(CloneStep.PROFILE, vm.state.value.step)    // no second tap needed
    }

    @Test
    fun `google sign-in shows waiting, then success moves to the profile step`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm(signedIn = false)
        vm.agreeAndContinue()
        val gate = kotlinx.coroutines.CompletableDeferred<Result<Unit>>()
        vm.signInWithGoogle { gate.await() }
        assertTrue(vm.state.value.waitingForGoogle)
        assertTrue(vm.state.value.signingIn)
        assertEquals(CloneStep.SIGN_IN, vm.state.value.step)
        gate.complete(Result.success(Unit))
        assertFalse(vm.state.value.waitingForGoogle)
        assertTrue(vm.state.value.signedIn)
        assertEquals(CloneStep.PROFILE, vm.state.value.step)
    }

    @Test
    fun `cancel stops waiting without an error and the flow can be started again`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm(signedIn = false)
        vm.agreeAndContinue()
        val gate = kotlinx.coroutines.CompletableDeferred<Result<Unit>>()
        vm.signInWithGoogle { gate.await() }
        vm.cancelGoogleSignIn()
        assertFalse(vm.state.value.waitingForGoogle)
        assertFalse(vm.state.value.signingIn)
        assertNull(vm.state.value.failure)
        assertTrue(gate.isCancelled || !gate.isCompleted)
        vm.signInWithGoogle { Result.success(Unit) }
        assertEquals(CloneStep.PROFILE, vm.state.value.step)
    }

    @Test
    fun `google failures show their message on the sign-in page`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm(signedIn = false)
        vm.agreeAndContinue()
        vm.signInWithGoogle { Result.failure(GoogleSignInException(GoogleSignInErrorKind.FAILED, GoogleBrowserAuth.MSG_FAILED)) }
        assertEquals("Google sign-in didn't complete. Try again.", vm.state.value.failure?.message)
        assertEquals(FailureSource.SIGN_IN, vm.state.value.failureSource)
        assertEquals(CloneStep.SIGN_IN, vm.state.value.step)
        assertFalse(vm.state.value.waitingForGoogle)

        vm.signInWithGoogle { Result.failure(GoogleSignInException(GoogleSignInErrorKind.TIMEOUT, GoogleBrowserAuth.MSG_TIMEOUT)) }
        assertEquals(GoogleBrowserAuth.MSG_TIMEOUT, vm.state.value.failure?.message)

        vm.signInWithGoogle { Result.failure(GoTrueException(GoTrueErrorKind.NETWORK, SupabaseGoTrueClient.MSG_NETWORK)) }
        assertEquals(SupabaseGoTrueClient.MSG_NETWORK, vm.state.value.failure?.message)
    }

    @Test
    fun `signed-in user skips the sign-in page`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm(signedIn = true)
        vm.agreeAndContinue()
        assertEquals(CloneStep.PROFILE, vm.state.value.step)
    }

    @Test
    fun `back from the sign-in page returns to the intro, and a failed sign-in stays on the sign-in page`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm(signedIn = false)
        vm.agreeAndContinue()
        vm.signIn { Result.failure(IllegalStateException("x")) }
        assertEquals(CloneStep.SIGN_IN, vm.state.value.step)
        assertFalse(vm.state.value.signedIn)
        assertTrue(vm.back())
        assertEquals(CloneStep.INTRO, vm.state.value.step)
    }

    @Test
    fun `failed sign-in shows a message and stays signed out`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm(signedIn = false)
        vm.signIn { Result.failure(IllegalStateException("cancelled")) }
        assertFalse(vm.state.value.signedIn)
        assertFalse(vm.state.value.signingIn)
        assertEquals(Recovery.SIGN_IN, vm.state.value.failure?.recovery)
    }

    @Test
    fun `sign-in error text from the server mapping is what the intro screen shows`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm(signedIn = false)
        vm.signIn { Result.failure(GoTrueException(GoTrueErrorKind.INVALID_CREDENTIALS, "That email or password is incorrect.")) }
        val s = vm.state.value
        assertEquals("That email or password is incorrect.", s.failure?.message)
        assertEquals(FailureSource.SIGN_IN, s.failureSource)
        assertEquals(CloneStep.INTRO, s.step)
        assertFalse(s.signedIn)
    }

    @Test
    fun `sign-in error is cleared when a new attempt starts or the form is switched`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm(signedIn = false)
        vm.signIn { Result.failure(IllegalStateException("x")) }
        assertNotNull(vm.state.value.failure)
        vm.clearAuthMessages()
        assertNull(vm.state.value.failure)
        vm.signIn { Result.success(Unit) }
        assertNull(vm.state.value.failure)
        assertTrue(vm.state.value.signedIn)
    }

    @Test
    fun `signup needing confirmation shows a notice and stays signed out`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm(signedIn = false)
        vm.signUp { Result.success(SignUpResult.ConfirmationRequired("a@b.co")) }
        val s = vm.state.value
        assertFalse(s.signedIn)
        assertFalse(s.signingIn)
        assertNull(s.failure)
        assertTrue(s.authNotice!!.contains("a@b.co"))
    }

    @Test
    fun `signup with an immediate session signs in`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm(signedIn = false)
        vm.signUp { Result.success(SignUpResult.SignedIn(com.listenai.service.auth.GoTrueSession("a", "r", 1L, "u", "a@b.co", null))) }
        assertTrue(vm.state.value.signedIn)
        assertNull(vm.state.value.authNotice)
    }

    @Test
    fun `password reset shows a confirmation notice and failures show the mapped error`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm(signedIn = false)
        vm.sendPasswordReset(" a@b.co ") { Result.success(Unit) }
        assertTrue(vm.state.value.authNotice!!.contains("a@b.co"))
        assertFalse(vm.state.value.signedIn)

        vm.sendPasswordReset("a@b.co") { Result.failure(GoTrueException(GoTrueErrorKind.RATE_LIMITED, "Too many attempts.")) }
        assertNull(vm.state.value.authNotice)
        assertEquals("Too many attempts.", vm.state.value.failure?.message)
    }

    @Test
    fun `eligibility errors surface at the phrase step before any recording`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm()
        client.challengeResults += { throw err(403, "email_unverified") }
        vm.agreeAndContinue()
        vm.setName("Mine")
        vm.continueFromProfile()
        val s = vm.state.value
        assertEquals(CloneStep.ERROR, s.step)
        assertEquals("email_unverified", s.failure?.code)
        assertEquals(Recovery.STOP, s.failure?.recovery)
        assertEquals(0, client.createCalls)
    }

    @Test
    fun `payment_required and unavailable also stop at the phrase step`() {
        for ((status, code) in listOf(402 to "payment_required", 503 to "unavailable")) {
            val scope = TestScope(scopeDispatcher)
            val vm = scope.vm()
            client.challengeResults += { throw err(status, code) }
            vm.agreeAndContinue(); vm.setName("n"); vm.continueFromProfile()
            assertEquals(code, vm.state.value.failure?.code)
            assertEquals(Recovery.STOP, vm.state.value.failure?.recovery)
        }
    }

    @Test
    fun `network failure on the phrase is retryable`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm()
        client.challengeResults += { throw VoiceCloneException.network(java.io.IOException("offline")) }
        client.challengeResults += { challenge("c2") }
        vm.agreeAndContinue(); vm.setName("n"); vm.continueFromProfile()
        assertEquals(Recovery.RETRY, vm.state.value.failure?.recovery)
        vm.recover()
        assertEquals(CloneStep.CONSENT, vm.state.value.step)
        assertEquals("c2", vm.state.value.challenge?.challengeId)
        assertNull(vm.state.value.failure)
    }

    @Test
    fun `speaker_mismatch with attempts left re-records the consent on the same challenge`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm()
        client.challengeResults += { challenge("c1") }
        client.createResults += { throw err(422, "speaker_mismatch", """{"attemptsLeft":2}""") }
        client.createResults += { voice() }
        vm.toReference()
        vm.setReferenceClip(clip("reference.m4a", 45))
        vm.submit()

        var s = vm.state.value
        assertEquals(CloneStep.ERROR, s.step)
        assertEquals(2, s.attemptsLeft)
        assertEquals(Recovery.RERECORD_CONSENT, s.failure?.recovery)
        assertTrue(s.failure!!.message.contains("2 attempts left"))

        vm.recover()
        s = vm.state.value
        assertEquals(CloneStep.CONSENT, s.step)
        assertNull("consent must be re-recorded", s.consentClip)
        assertNotNull("reference is kept", s.referenceClip)
        assertEquals("same challenge reused", "c1", s.challenge?.challengeId)
        assertEquals(1, client.challengeCalls)
        assertEquals(2, s.attemptsLeft)

        vm.setConsentClip(clip("consent2.m4a", 7))
        vm.continueFromConsent()
        vm.submit()
        assertEquals(CloneStep.SUCCESS, vm.state.value.step)
        assertEquals("consent2.m4a", client.lastCreate[3])
    }

    @Test
    fun `speaker_mismatch with no attempts left requests a new phrase`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm()
        client.challengeResults += { challenge("c1") }
        client.challengeResults += { challenge("c2") }
        client.createResults += { throw err(422, "speaker_mismatch", """{"attemptsLeft":0}""") }
        vm.toReference()
        vm.setReferenceClip(clip("reference.m4a", 45))
        vm.submit()
        assertEquals(Recovery.NEW_CHALLENGE, vm.state.value.failure?.recovery)

        vm.recover()
        assertEquals(CloneStep.CONSENT, vm.state.value.step)
        assertEquals("c2", vm.state.value.challenge?.challengeId)
        assertNull(vm.state.value.consentClip)
        assertNull("fresh challenge resets attempts", vm.state.value.attemptsLeft)
    }

    @Test
    fun `reference_rejected goes back to choose another recording and keeps the consent clip`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm()
        client.challengeResults += { challenge("c1") }
        client.createResults += { throw err(422, "reference_rejected", """{"failures":[{"code":"too_noisy","message":"x"}]}""") }
        vm.toReference()
        vm.setReferenceClip(clip("reference.m4a", 45))
        vm.submit()
        assertEquals(Recovery.FIX_REFERENCE, vm.state.value.failure?.recovery)
        assertEquals(1, vm.state.value.failure?.problems?.size)

        vm.recover()
        val s = vm.state.value
        assertEquals(CloneStep.REFERENCE, s.step)
        assertNull(s.referenceClip)
        assertNotNull(s.consentClip)
    }

    @Test
    fun `an expired challenge is detected locally without an upload`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm()
        client.challengeResults += { challenge("c1", ttlMs = 60_000) }
        client.challengeResults += { challenge("c2") }
        vm.toReference()
        vm.setReferenceClip(clip("reference.m4a", 45))
        now += 120_000 // user took too long
        vm.submit()

        assertEquals(0, client.createCalls)
        assertEquals("challenge_expired", vm.state.value.failure?.code)
        vm.recover()
        assertEquals("c2", vm.state.value.challenge?.challengeId)
        assertEquals(CloneStep.CONSENT, vm.state.value.step)
    }

    @Test
    fun `server challenge_expired and daily_limit`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm()
        client.challengeResults += { challenge("c1") }
        client.createResults += { throw err(429, "daily_limit", """{"limit":3,"used":3}""") }
        vm.toReference()
        vm.setReferenceClip(clip("reference.m4a", 45))
        vm.submit()
        assertEquals(Recovery.STOP, vm.state.value.failure?.recovery)
        assertTrue(vm.state.value.failure!!.message.contains("3"))
    }

    @Test
    fun `retry after a transient submit failure resubmits the same clips`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm()
        client.challengeResults += { challenge("c1") }
        client.createResults += { throw err(503, "service_unavailable") }
        client.createResults += { voice() }
        vm.toReference()
        vm.setReferenceClip(clip("reference.m4a", 45))
        vm.submit()
        assertEquals(Recovery.RETRY, vm.state.value.failure?.recovery)
        vm.recover()
        assertEquals(CloneStep.SUCCESS, vm.state.value.step)
        assertEquals(2, client.createCalls)
    }

    @Test
    fun `clips outside the documented duration limits are rejected locally`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm()
        vm.setReferenceClip(clip("r.m4a", 5))
        assertNull(vm.state.value.referenceClip)
        assertTrue(vm.state.value.clipHint!!.contains("at least 8"))
        vm.setReferenceClip(clip("r.m4a", 121))
        assertNull(vm.state.value.referenceClip)
        vm.setReferenceClip(clip("r.m4a", 8))
        assertNotNull(vm.state.value.referenceClip)
        vm.setReferenceClip(clip("r.m4a", 120))
        assertNotNull(vm.state.value.referenceClip)

        vm.setConsentClip(clip("c.m4a", 2))
        assertNull(vm.state.value.consentClip)
        vm.setConsentClip(clip("c.m4a", 3))
        assertNotNull(vm.state.value.consentClip)
        vm.setConsentClip(clip("c.m4a", 41))
        assertNull(vm.state.value.consentClip)
    }

    @Test
    fun `profile needs a name and a supported language`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm()
        assertFalse(vm.state.value.canContinueFromProfile)
        vm.setName("  ")
        assertFalse(vm.state.value.canContinueFromProfile)
        vm.setName("Me")
        assertTrue(vm.state.value.canContinueFromProfile)
        vm.setLanguage("xx")
        assertFalse(vm.state.value.canContinueFromProfile)
        assertEquals("de", VoiceCloneFlowViewModel.languageFor("de"))
        assertEquals("no", VoiceCloneFlowViewModel.languageFor("nb"))
        assertEquals("he", VoiceCloneFlowViewModel.languageFor("iw"))
        assertEquals("en", VoiceCloneFlowViewModel.languageFor("xx"))
        assertEquals("en", VoiceCloneFlowViewModel.languageFor(null))
    }

    @Test
    fun `back navigation walks the flow and stops at the ends`() {
        val scope = TestScope(scopeDispatcher)
        val vm = scope.vm()
        client.challengeResults += { challenge("c1") }
        vm.toReference()
        assertTrue(vm.back()); assertEquals(CloneStep.CONSENT, vm.state.value.step)
        assertTrue(vm.back()); assertEquals(CloneStep.PROFILE, vm.state.value.step)
        assertTrue(vm.back()); assertEquals(CloneStep.INTRO, vm.state.value.step)
        assertFalse(vm.back())
    }
}
