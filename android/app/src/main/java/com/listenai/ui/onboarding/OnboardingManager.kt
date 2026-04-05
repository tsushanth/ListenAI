package com.listenai.ui.onboarding

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Manages onboarding state and completion tracking for ListenAI.
 * Ensures onboarding only shows on first launch or when version increments.
 */
class OnboardingManager(context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    // Current onboarding version - increment to show onboarding again
    private val currentVersion = 1

    private val _hasCompletedOnboarding = MutableStateFlow(loadOnboardingState())
    val hasCompletedOnboarding: StateFlow<Boolean> = _hasCompletedOnboarding

    private val _selectedVoiceId = MutableStateFlow(prefs.getString(KEY_SELECTED_VOICE_ID, null))
    val selectedVoiceId: StateFlow<String?> = _selectedVoiceId

    private val _currentPage = MutableStateFlow(OnboardingPage.WELCOME)
    val currentPage: StateFlow<OnboardingPage> = _currentPage

    /**
     * Load onboarding state from SharedPreferences.
     * Returns true only if user has completed AND version matches or is greater.
     */
    private fun loadOnboardingState(): Boolean {
        val savedVersion = prefs.getInt(KEY_ONBOARDING_VERSION, 0)
        val hasCompleted = prefs.getBoolean(KEY_HAS_COMPLETED_ONBOARDING, false)

        // Show onboarding if never completed or if version changed
        return hasCompleted && savedVersion >= currentVersion
    }

    /**
     * Mark onboarding as complete and save version.
     */
    fun completeOnboarding() {
        prefs.edit().apply {
            putBoolean(KEY_HAS_COMPLETED_ONBOARDING, true)
            putInt(KEY_ONBOARDING_VERSION, currentVersion)
            apply()
        }
        _hasCompletedOnboarding.value = true
    }

    /**
     * Reset onboarding for testing or re-showing.
     */
    fun resetOnboarding() {
        prefs.edit().apply {
            putBoolean(KEY_HAS_COMPLETED_ONBOARDING, false)
            remove(KEY_SELECTED_VOICE_ID)
            apply()
        }
        _hasCompletedOnboarding.value = false
        _selectedVoiceId.value = null
        _currentPage.value = OnboardingPage.WELCOME
    }

    /**
     * Set the selected voice during onboarding.
     */
    fun setSelectedVoice(voiceId: String) {
        prefs.edit().putString(KEY_SELECTED_VOICE_ID, voiceId).apply()
        _selectedVoiceId.value = voiceId
    }

    /**
     * Navigate to the next page.
     */
    fun nextPage() {
        _currentPage.value.next?.let {
            _currentPage.value = it
        }
    }

    /**
     * Navigate to the previous page.
     */
    fun previousPage() {
        _currentPage.value.previous?.let {
            _currentPage.value = it
        }
    }

    /**
     * Skip directly to paywall page.
     */
    fun skipToPaywall() {
        _currentPage.value = OnboardingPage.PAYWALL
    }

    /**
     * Go to a specific page.
     */
    fun goToPage(page: OnboardingPage) {
        _currentPage.value = page
    }

    companion object {
        private const val PREFS_NAME = "onboarding_prefs"
        private const val KEY_HAS_COMPLETED_ONBOARDING = "hasCompletedOnboarding"
        private const val KEY_SELECTED_VOICE_ID = "onboardingSelectedVoiceId"
        private const val KEY_ONBOARDING_VERSION = "onboardingVersion"

        @Volatile
        private var instance: OnboardingManager? = null

        fun getInstance(context: Context): OnboardingManager {
            return instance ?: synchronized(this) {
                instance ?: OnboardingManager(context.applicationContext).also { instance = it }
            }
        }
    }
}

/**
 * Onboarding pages enum matching iOS implementation.
 */
enum class OnboardingPage(val index: Int) {
    WELCOME(0),
    DOCUMENT_TO_AUDIO(1),
    TAKE_NOTES(2),
    PRODUCTIVITY(3),
    VOICE_SELECTION(4),
    PAYWALL(5);

    val next: OnboardingPage?
        get() = entries.find { it.index == index + 1 }

    val previous: OnboardingPage?
        get() = entries.find { it.index == index - 1 }

    val isFirst: Boolean
        get() = this == WELCOME

    val isLast: Boolean
        get() = this == PAYWALL

    val showsBackButton: Boolean
        get() = !isFirst && this != PAYWALL

    val showsSkipButton: Boolean
        get() = this != PAYWALL && this != VOICE_SELECTION
}
