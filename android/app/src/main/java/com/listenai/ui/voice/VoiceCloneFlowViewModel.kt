package com.listenai.ui.voice

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.listenai.service.auth.GoTrueException
import com.listenai.service.auth.GoogleSignInException
import kotlinx.coroutines.Job
import com.listenai.service.auth.SignUpResult
import com.listenai.service.voice.AudioClip
import com.listenai.service.voice.ClonedVoice
import com.listenai.service.voice.ConsentChallenge
import com.listenai.service.voice.Recovery
import com.listenai.service.voice.VoiceCloneClient
import com.listenai.service.voice.VoiceCloneErrors
import com.listenai.service.voice.VoiceCloneException
import com.listenai.service.voice.VoiceCloneFailure
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class CloneStep {
    /** Short explainer of the consent check; "Next" goes to sign-in (or straight on when already signed in). */
    INTRO,

    /** Email + password sign-in / account creation, on its own page so the form is never below the fold. */
    SIGN_IN,

    /** Voice name and language. */
    PROFILE,

    /** Show the server's random phrase and record it live. */
    CONSENT,

    /** Record or pick a 8 to 120 s reference clip, then submit. */
    REFERENCE,

    UPLOADING,
    SUCCESS,
    ERROR
}

/** Where a failure happened; decides what "retry" means. */
enum class FailureSource { CHALLENGE, SUBMIT, SIGN_IN }

data class CloneFlowState(
    val step: CloneStep = CloneStep.INTRO,
    val signedIn: Boolean = false,
    val signingIn: Boolean = false,
    /** True while the browser Google sign-in is open and we are waiting for its deep-link callback. */
    val waitingForGoogle: Boolean = false,
    val name: String = "",
    val language: String = "en",
    val challenge: ConsentChallenge? = null,
    val loadingChallenge: Boolean = false,
    val consentClip: AudioClip? = null,
    val referenceClip: AudioClip? = null,
    /** Remaining consent attempts, as last reported by the server (null before the first attempt). */
    val attemptsLeft: Int? = null,
    val failure: VoiceCloneFailure? = null,
    /** Non-error feedback on the sign-in form (verification or reset email sent). */
    val authNotice: String? = null,
    val failureSource: FailureSource? = null,
    /** Local, pre-upload hint about the clip the user just made or picked. */
    val clipHint: String? = null,
    val created: ClonedVoice? = null
) {
    val canContinueFromProfile: Boolean get() = name.isNotBlank() && language in SUPPORTED_LANGUAGES
    val canContinueFromConsent: Boolean get() = challenge != null && consentClip != null
    val canSubmit: Boolean get() = challenge != null && consentClip != null && referenceClip != null
}

val SUPPORTED_LANGUAGES: Set<String> = linkedSetOf(
    "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh"
)

/**
 * Drives the consent-gated cloning flow:
 *   sign in -> name/language -> request phrase -> record phrase -> record/pick reference -> upload.
 * All server error codes are mapped by [VoiceCloneErrors] and turned into a [Recovery] action here.
 */
class VoiceCloneFlowViewModel(
    private val client: VoiceCloneClient,
    initialSignedIn: Boolean,
    private val clock: () -> Long = System::currentTimeMillis,
    scopeOverride: CoroutineScope? = null,
    initialLanguage: String = "en",
    private val onCreated: (ClonedVoice) -> Unit = {}
) : ViewModel() {

    companion object {
        const val MIN_REFERENCE_SEC = 8
        const val RECOMMENDED_REFERENCE_SEC = 30
        const val MAX_REFERENCE_SEC = 120
        const val MIN_CONSENT_SEC = 3
        const val MAX_CONSENT_SEC = 40
        const val MAX_NAME_LENGTH = 100

        /** Closest supported cloning language for a device locale language tag, defaulting to English. */
        fun languageFor(localeLanguage: String?): String {
            val l = when (val raw = localeLanguage?.lowercase().orEmpty()) {
                "nb", "nn" -> "no"
                "iw" -> "he"
                else -> raw
            }
            return if (l in SUPPORTED_LANGUAGES) l else "en"
        }
    }

    private val scope: CoroutineScope = scopeOverride ?: viewModelScope

    private val _state = MutableStateFlow(CloneFlowState(signedIn = initialSignedIn, language = initialLanguage))
    val state: StateFlow<CloneFlowState> = _state.asStateFlow()

    // ---- sign in -----------------------------------------------------------------------

    fun onSignedInChanged(signedIn: Boolean) {
        _state.update { it.copy(signedIn = signedIn) }
    }

    /** [block] performs the sign-in (email+password, or interactive Google which needs an Activity). */
    fun signIn(block: suspend () -> Result<Unit>) {
        runAuth(block) { true }
    }

    /** Create account: either signs in, or tells the user to confirm their email first. */
    fun signUp(block: suspend () -> Result<SignUpResult>) {
        runAuth(block) { result ->
            if (result is SignUpResult.ConfirmationRequired) {
                _state.update {
                    it.copy(authNotice = "Account created. We sent a verification link to ${result.email}. Verify your email, then sign in.")
                }
                false
            } else true
        }
    }

    fun sendPasswordReset(email: String, block: suspend () -> Result<Unit>) {
        runAuth(block) {
            _state.update {
                it.copy(authNotice = "If an account exists for ${email.trim()}, we sent a link to reset the password. Check your email.")
            }
            false
        }
    }

    private var authJob: Job? = null

    /** Google via the browser (Supabase PKCE). Shows the waiting state until it finishes or [cancelGoogleSignIn]. */
    fun signInWithGoogle(block: suspend () -> Result<Unit>) {
        if (_state.value.signingIn) return
        runAuth(block, google = true) { true }
    }

    /** Abandons the browser sign-in (the pending verifier is dropped by the auth layer on cancellation). No error is shown. */
    fun cancelGoogleSignIn() {
        if (!_state.value.waitingForGoogle) return
        authJob?.cancel()
        authJob = null
        _state.update { it.copy(signingIn = false, waitingForGoogle = false, failure = null, failureSource = null) }
    }

    fun clearAuthMessages() = _state.update { it.copy(failure = null, failureSource = null, authNotice = null) }

    /** Runs [block]; [onSuccess] returns whether the user is now signed in. */
    private fun <T> runAuth(block: suspend () -> Result<T>, google: Boolean = false, onSuccess: (T) -> Boolean) {
        if (_state.value.signingIn) return
        _state.update { it.copy(signingIn = true, waitingForGoogle = google, failure = null, failureSource = null, authNotice = null) }
        authJob = scope.launch {
            val result = try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Result.failure(e)
            }
            val signedIn = result.getOrNull()?.let(onSuccess) ?: false
            _state.update {
                if (result.isSuccess) {
                    if (signedIn) {
                        it.copy(signingIn = false, waitingForGoogle = false, signedIn = true, failure = null, failureSource = null, authNotice = null, step = afterSignIn(it.step))
                    } else it.copy(signingIn = false, waitingForGoogle = false)
                } else {
                    it.copy(
                        signingIn = false,
                        waitingForGoogle = false,
                        failure = VoiceCloneFailure(
                            "sign_in_failed",
                            result.exceptionOrNull().let { (it as? GoTrueException)?.message ?: (it as? GoogleSignInException)?.message }
                                ?: "Sign-in didn't complete. Try again.",
                            Recovery.SIGN_IN
                        ),
                        failureSource = FailureSource.SIGN_IN
                    )
                }
            }
        }
    }

    // ---- navigation --------------------------------------------------------------------

    /** "Next" on the intro: sign-in page when signed out, otherwise straight to the profile step. */
    fun agreeAndContinue() {
        val next = if (_state.value.signedIn) CloneStep.PROFILE else CloneStep.SIGN_IN
        _state.update { it.copy(step = next, failure = null, failureSource = null, authNotice = null) }
    }

    private fun afterSignIn(step: CloneStep): CloneStep = when (step) {
        CloneStep.ERROR -> CloneStep.INTRO
        CloneStep.SIGN_IN -> CloneStep.PROFILE
        else -> step
    }

    fun setName(name: String) = _state.update { it.copy(name = name.take(MAX_NAME_LENGTH)) }

    fun setLanguage(language: String) = _state.update { it.copy(language = language) }

    fun continueFromProfile() {
        val s = _state.value
        if (!s.canContinueFromProfile) return
        _state.update { it.copy(step = CloneStep.CONSENT, consentClip = null, referenceClip = null, clipHint = null, failure = null) }
        requestChallenge()
    }

    fun continueFromConsent() {
        if (!_state.value.canContinueFromConsent) return
        _state.update { it.copy(step = CloneStep.REFERENCE, clipHint = null) }
    }

    /** Back one step; never leaves the flow while an upload is in flight. */
    fun back(): Boolean {
        val s = _state.value
        val prev = when (s.step) {
            CloneStep.SIGN_IN -> CloneStep.INTRO
            CloneStep.PROFILE -> CloneStep.INTRO
            CloneStep.CONSENT -> CloneStep.PROFILE
            CloneStep.REFERENCE -> CloneStep.CONSENT
            else -> return false
        }
        _state.update { it.copy(step = prev, clipHint = null) }
        return true
    }

    // ---- challenge ---------------------------------------------------------------------

    fun requestChallenge() {
        if (_state.value.loadingChallenge) return
        _state.update { it.copy(step = CloneStep.CONSENT, loadingChallenge = true, failure = null, challenge = null, consentClip = null, attemptsLeft = null) }
        scope.launch {
            try {
                val c = client.requestConsentChallenge()
                _state.update { it.copy(loadingChallenge = false, challenge = c, step = CloneStep.CONSENT) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: VoiceCloneException) {
                fail(e, FailureSource.CHALLENGE)
            } catch (e: Exception) {
                fail(VoiceCloneException.network(e), FailureSource.CHALLENGE)
            }
        }
    }

    // ---- clips -------------------------------------------------------------------------

    fun setConsentClip(clip: AudioClip) {
        val hint = when {
            clip.durationSec < MIN_CONSENT_SEC -> "That was too short. Read the whole phrase."
            clip.durationSec > MAX_CONSENT_SEC -> "That was too long. Read only the phrase."
            else -> null
        }
        _state.update { it.copy(consentClip = if (hint == null) clip else null, clipHint = hint) }
    }

    fun clearConsentClip() = _state.update { it.copy(consentClip = null, clipHint = null) }

    fun setReferenceClip(clip: AudioClip) {
        val hint = when {
            clip.durationSec < MIN_REFERENCE_SEC ->
                "That's too short. Use at least $MIN_REFERENCE_SEC seconds (30 to 60 seconds works best)."
            clip.durationSec > MAX_REFERENCE_SEC ->
                "That's too long. Use at most ${MAX_REFERENCE_SEC / 60} minutes."
            else -> null
        }
        _state.update { it.copy(referenceClip = if (hint == null) clip else null, clipHint = hint) }
    }

    fun clearReferenceClip() = _state.update { it.copy(referenceClip = null, clipHint = null) }

    /** Surface a problem picking/recording a clip (unsupported type, unreadable file...). */
    fun setClipHint(message: String?) = _state.update { it.copy(clipHint = message) }

    // ---- submit ------------------------------------------------------------------------

    fun submit() {
        val s = _state.value
        if (!s.canSubmit || s.step == CloneStep.UPLOADING) return
        val challenge = s.challenge!!
        if (challenge.isExpired(clock())) {
            // Don't spend an upload on a challenge the server will reject.
            fail(VoiceCloneException(410, "challenge_expired", null), FailureSource.SUBMIT)
            return
        }
        _state.update { it.copy(step = CloneStep.UPLOADING, failure = null) }
        scope.launch {
            try {
                val voice = client.createVoice(
                    challengeId = challenge.challengeId,
                    name = s.name.trim(),
                    language = s.language,
                    consent = s.consentClip!!,
                    reference = s.referenceClip!!
                )
                _state.update { it.copy(step = CloneStep.SUCCESS, created = voice) }
                onCreated(voice)
            } catch (e: CancellationException) {
                throw e
            } catch (e: VoiceCloneException) {
                fail(e, FailureSource.SUBMIT)
            } catch (e: Exception) {
                fail(VoiceCloneException.network(e), FailureSource.SUBMIT)
            }
        }
    }

    // ---- failure handling --------------------------------------------------------------

    private fun fail(e: VoiceCloneException, source: FailureSource) {
        val failure = VoiceCloneErrors.map(e)
        _state.update {
            it.copy(
                step = CloneStep.ERROR,
                loadingChallenge = false,
                failure = failure,
                failureSource = source,
                attemptsLeft = failure.attemptsLeft ?: it.attemptsLeft
            )
        }
    }

    /** Primary button on the error screen. [STOP] failures are handled by the caller (close). */
    fun recover() {
        val s = _state.value
        val failure = s.failure ?: return
        when (failure.recovery) {
            Recovery.SIGN_IN -> _state.update { it.copy(step = CloneStep.SIGN_IN, failure = null) }

            Recovery.RETRY -> when (s.failureSource) {
                FailureSource.CHALLENGE -> requestChallenge()
                FailureSource.SUBMIT -> if (s.canSubmit) submit() else _state.update { it.copy(step = CloneStep.REFERENCE, failure = null) }
                else -> _state.update { it.copy(step = CloneStep.INTRO, failure = null) }
            }

            // Same challenge, new recording of the phrase.
            Recovery.RERECORD_CONSENT ->
                _state.update { it.copy(step = CloneStep.CONSENT, consentClip = null, failure = null, clipHint = null) }

            Recovery.NEW_CHALLENGE -> {
                _state.update { it.copy(step = CloneStep.CONSENT, consentClip = null, failure = null, clipHint = null) }
                requestChallenge()
            }

            Recovery.FIX_REFERENCE ->
                _state.update { it.copy(step = CloneStep.REFERENCE, referenceClip = null, failure = null, clipHint = null) }

            Recovery.STOP -> Unit
        }
    }
}
