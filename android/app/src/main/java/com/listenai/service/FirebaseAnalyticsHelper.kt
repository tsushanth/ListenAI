package com.listenai.service

import android.content.Context
import android.os.Bundle
import android.util.Log
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.analytics.ktx.analytics
import com.google.firebase.ktx.Firebase

object FirebaseAnalyticsHelper {
    private const val TAG = "FirebaseAnalytics"

    private var firebaseAnalytics: FirebaseAnalytics? = null
    private var isInitialized = false

    /** True only after the user allowed analytics. Every event and user property is dropped otherwise. */
    @Volatile
    private var collectionAllowed = false

    fun initialize(context: Context) {
        try {
            firebaseAnalytics = Firebase.analytics
            isInitialized = true
            Log.d(TAG, "Firebase Analytics initialized")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize Firebase Analytics: ${e.message}")
        }
    }

    /**
     * Applies the user's analytics choice. Allowed: collection on (analytics storage only; ad storage,
     * ad user data and ad personalization stay denied). Not allowed or not asked yet: collection off and
     * any locally stored analytics data reset.
     */
    fun applyConsent(allowed: Boolean) {
        val analytics = firebaseAnalytics ?: return
        val wasAllowed = collectionAllowed
        collectionAllowed = allowed
        try {
            analytics.setAnalyticsCollectionEnabled(allowed)
            analytics.setConsent(
                mapOf(
                    FirebaseAnalytics.ConsentType.ANALYTICS_STORAGE to
                        if (allowed) FirebaseAnalytics.ConsentStatus.GRANTED else FirebaseAnalytics.ConsentStatus.DENIED,
                    FirebaseAnalytics.ConsentType.AD_STORAGE to FirebaseAnalytics.ConsentStatus.DENIED,
                    FirebaseAnalytics.ConsentType.AD_USER_DATA to FirebaseAnalytics.ConsentStatus.DENIED,
                    FirebaseAnalytics.ConsentType.AD_PERSONALIZATION to FirebaseAnalytics.ConsentStatus.DENIED
                )
            )
            if (allowed && !wasAllowed) {
                setUserProperty("device_language", java.util.Locale.getDefault().language)
                logAppOpen()
            } else if (!allowed) {
                analytics.resetAnalyticsData()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to apply analytics consent: ${e.message}")
        }
    }

    fun setUserId(userId: String?) {
        if (!collectionAllowed) return
        firebaseAnalytics?.setUserId(userId)
    }

    fun setUserProperty(name: String, value: String?) {
        if (!collectionAllowed) return
        firebaseAnalytics?.setUserProperty(name, value)
    }

    // Standard Events

    fun logAppOpen() {
        logEvent(FirebaseAnalytics.Event.APP_OPEN)
    }

    fun logScreenView(screenName: String, screenClass: String? = null) {
        val params = Bundle().apply {
            putString(FirebaseAnalytics.Param.SCREEN_NAME, screenName)
            screenClass?.let { putString(FirebaseAnalytics.Param.SCREEN_CLASS, it) }
        }
        logEvent(FirebaseAnalytics.Event.SCREEN_VIEW, params)
    }

    fun logSignUp(method: String) {
        val params = Bundle().apply {
            putString(FirebaseAnalytics.Param.METHOD, method)
        }
        logEvent(FirebaseAnalytics.Event.SIGN_UP, params)
    }

    fun logLogin(method: String) {
        val params = Bundle().apply {
            putString(FirebaseAnalytics.Param.METHOD, method)
        }
        logEvent(FirebaseAnalytics.Event.LOGIN, params)
    }

    // Onboarding Events

    fun logOnboardingStarted() {
        logEvent("onboarding_started")
    }

    fun logOnboardingPageViewed(page: Int) {
        val params = Bundle().apply {
            putInt("page", page)
        }
        logEvent("onboarding_page_viewed", params)
    }

    fun logOnboardingCompleted() {
        logEvent("onboarding_completed")
    }

    fun logOnboardingSkipped(atPage: Int) {
        val params = Bundle().apply {
            putInt("at_page", atPage)
        }
        logEvent("onboarding_skipped", params)
    }

    // Subscription Events

    fun logPaywallViewed(source: String? = null) {
        val params = Bundle().apply {
            source?.let { putString("source", it) }
        }
        logEvent("paywall_viewed", params)
    }

    fun logSubscriptionStarted(productId: String, isTrial: Boolean = false) {
        val params = Bundle().apply {
            putString("product_id", productId)
            putBoolean("is_trial", isTrial)
        }
        logEvent("subscription_started", params)
    }

    fun logPurchaseCompleted(productId: String, revenue: Double? = null) {
        val params = Bundle().apply {
            putString("product_id", productId)
            revenue?.let { putDouble(FirebaseAnalytics.Param.VALUE, it) }
            putString(FirebaseAnalytics.Param.CURRENCY, "USD")
        }
        logEvent(FirebaseAnalytics.Event.PURCHASE, params)
    }

    // Content Import Events

    fun logContentImported(importMode: String, language: String? = null) {
        val params = Bundle().apply {
            putString("import_mode", importMode) // url, document, text, clipboard, email
            putString("content_language", language ?: "unknown") // demand signal; "unknown" = too short or low confidence
        }
        logEvent("content_imported", params)
    }

    /** A non-English article had to be read with a voice that is not native to its language. */
    fun logVoiceFallback(language: String, reason: String) {
        logEvent("voice_fallback", Bundle().apply {
            putString("content_language", language)
            putString("reason", reason) // no_voice, engine_error
        })
    }

    /** The user tapped "I want a natural voice for this language". The strongest demand signal. */
    fun logVoiceRequest(language: String) {
        logEvent("voice_request", Bundle().apply { putString("content_language", language) })
    }

    /**
     * [error] is accepted for source compatibility but deliberately not sent: exception messages can contain
     * fragments of the URL or document the user imported.
     */
    @Suppress("UNUSED_PARAMETER")
    fun logImportFailed(importMode: String, error: String? = null) {
        val params = Bundle().apply {
            putString("import_mode", importMode)
        }
        logEvent("import_failed", params)
    }

    // Playback Events

    /** Fired once per install, the first time the user starts playing audio. */
    fun logFirstListen() {
        logEvent("first_listen")
    }

    fun logPlaybackStarted(contentType: String? = null) {
        val params = Bundle().apply {
            contentType?.let { putString("content_type", it) }
        }
        logEvent("playback_started", params)
    }

    fun logPlaybackCompleted(durationSeconds: Long? = null) {
        val params = Bundle().apply {
            durationSeconds?.let { putLong("duration_seconds", it) }
        }
        logEvent("playback_completed", params)
    }

    // Feature Usage Events

    fun logVoiceChanged(voiceId: String? = null) {
        val params = Bundle().apply {
            voiceId?.let { putString("voice_id", it) }
        }
        logEvent("voice_changed", params)
    }

    fun logVoiceCloningStarted() {
        logEvent("voice_cloning_started")
    }

    fun logVoiceCloningCompleted() {
        logEvent("voice_cloning_completed")
    }

    fun logQuotaReached() {
        logEvent("quota_reached")
    }

    /** Parameterless event, for experiments that only need a count. Still dropped unless analytics consent is on. */
    fun logSimpleEvent(eventName: String) = logEvent(eventName)

    // Core Logging

    private fun logEvent(eventName: String, params: Bundle? = null) {
        if (!isInitialized) {
            Log.w(TAG, "Firebase Analytics not initialized, skipping event: $eventName")
            return
        }
        if (!collectionAllowed) return
        try {
            firebaseAnalytics?.logEvent(eventName, params)
            Log.d(TAG, "Logged event: $eventName")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to log event $eventName: ${e.message}")
        }
    }
}
