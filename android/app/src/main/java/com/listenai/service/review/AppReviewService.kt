package com.listenai.service.review

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.google.android.play.core.review.ReviewManagerFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Date
import java.util.concurrent.TimeUnit

/**
 * Service for managing Google Play Store review prompts.
 * Uses a feedback flow: first asks if user is enjoying, then triggers native review if yes.
 *
 * Mirrors iOS AppReviewService behavior:
 * - Rate limits prompts (max 3 prompts, minimum 30 days between)
 * - Triggers after voice clone success or TTS playback start
 * - Shows custom feedback prompt before native review
 */
class AppReviewService private constructor(private val context: Context) {

    companion object {
        private const val TAG = "AppReviewService"

        // SharedPreferences keys
        private const val PREFS_NAME = "app_review_prefs"
        private const val KEY_LAST_PROMPT_DATE = "appReview_lastPromptDate"
        private const val KEY_PROMPT_COUNT = "appReview_promptCount"
        private const val KEY_HAS_COMPLETED_REVIEW = "appReview_hasCompleted"
        private const val KEY_HAS_COMPLETED_JOURNEY = "appReview_hasCompletedJourney"

        // Configuration
        private const val MINIMUM_DAYS_BETWEEN_PROMPTS = 30
        private const val MAX_PROMPTS = 3

        @Volatile
        private var INSTANCE: AppReviewService? = null

        fun getInstance(context: Context): AppReviewService {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: AppReviewService(context.applicationContext).also { INSTANCE = it }
            }
        }
    }

    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    // State flow for UI observation
    private val _shouldShowFeedbackPrompt = MutableStateFlow(false)
    val shouldShowFeedbackPrompt: StateFlow<Boolean> = _shouldShowFeedbackPrompt.asStateFlow()

    /**
     * Check and trigger feedback prompt if appropriate.
     * Emits to shouldShowFeedbackPrompt state flow if conditions are met.
     */
    fun checkAndTriggerFeedbackPrompt() {
        if (shouldShowFeedbackPromptInternal()) {
            recordFeedbackPromptShown()
            _shouldShowFeedbackPrompt.value = true
            Log.i(TAG, "Triggering feedback prompt")
        }
    }

    /**
     * Dismiss the feedback prompt (called after user responds or dismisses)
     */
    fun dismissFeedbackPrompt() {
        _shouldShowFeedbackPrompt.value = false
    }

    // MARK: - Public API

    /**
     * Call this after a successful voice clone creation
     */
    fun recordVoiceCloneSuccess() {
        prefs.edit().putBoolean(KEY_HAS_COMPLETED_JOURNEY, true).apply()
        Log.i(TAG, "Voice clone success recorded - user journey complete")
    }

    /**
     * Call this after first successful TTS playback start
     */
    fun recordTTSPlaybackSuccess() {
        prefs.edit().putBoolean(KEY_HAS_COMPLETED_JOURNEY, true).apply()
        Log.i(TAG, "TTS playback success recorded - user journey complete")
    }

    /**
     * Check if we should show the feedback prompt (internal logic)
     */
    private fun shouldShowFeedbackPromptInternal(): Boolean {
        // Don't show if user has already completed a review
        if (prefs.getBoolean(KEY_HAS_COMPLETED_REVIEW, false)) {
            Log.d(TAG, "Skipping feedback: user has completed review")
            return false
        }

        // Don't show if we've reached max prompts
        val promptCount = prefs.getInt(KEY_PROMPT_COUNT, 0)
        if (promptCount >= MAX_PROMPTS) {
            Log.d(TAG, "Skipping feedback: max prompts reached ($promptCount)")
            return false
        }

        // Check if enough time has passed since last prompt
        val lastPromptDate = prefs.getLong(KEY_LAST_PROMPT_DATE, 0L)
        if (lastPromptDate > 0) {
            val daysSinceLastPrompt = TimeUnit.MILLISECONDS.toDays(Date().time - lastPromptDate)
            if (daysSinceLastPrompt < MINIMUM_DAYS_BETWEEN_PROMPTS) {
                Log.d(TAG, "Skipping feedback: only $daysSinceLastPrompt days since last prompt")
                return false
            }
        }

        // Check if user has completed at least one successful journey (voice clone OR TTS playback)
        if (!prefs.getBoolean(KEY_HAS_COMPLETED_JOURNEY, false)) {
            Log.d(TAG, "Skipping feedback: no successful journey completed yet")
            return false
        }

        Log.i(TAG, "Should show feedback prompt")
        return true
    }

    /**
     * Record that we showed a feedback prompt
     */
    private fun recordFeedbackPromptShown() {
        val promptCount = prefs.getInt(KEY_PROMPT_COUNT, 0)
        prefs.edit()
            .putInt(KEY_PROMPT_COUNT, promptCount + 1)
            .putLong(KEY_LAST_PROMPT_DATE, Date().time)
            .apply()
        Log.i(TAG, "Feedback prompt shown. Total prompts: ${promptCount + 1}")
    }

    /**
     * User responded positively - trigger native Google Play review
     */
    fun requestPlayStoreReview(activity: Activity) {
        Log.i(TAG, "User enjoying app - requesting Play Store review")

        // Mark as completed so we don't ask again
        prefs.edit().putBoolean(KEY_HAS_COMPLETED_REVIEW, true).apply()

        // Request the native Play Store review
        val reviewManager = ReviewManagerFactory.create(context)
        val request = reviewManager.requestReviewFlow()

        request.addOnCompleteListener { task ->
            if (task.isSuccessful) {
                val reviewInfo = task.result
                val flow = reviewManager.launchReviewFlow(activity, reviewInfo)
                flow.addOnCompleteListener {
                    Log.i(TAG, "Review flow completed")
                }
            } else {
                Log.e(TAG, "Failed to get review info: ${task.exception?.message}")
            }
        }
    }

    /**
     * User responded negatively - could open feedback form in future
     */
    fun userNotEnjoying() {
        Log.i(TAG, "User not enjoying - skipping review request")
        // Just dismiss the prompt and don't ask again for a while
        // In future, could open a feedback form here
    }
}
