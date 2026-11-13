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

    /** A read ended with no usable voice for its language; [reason] is no_voice, no_engine, offline or engine_error. */
    fun logVoiceFallback(language: String, reason: String) {
        logEvent("voice_fallback", LanguageAnalytics.voiceFallback(language, reason).toBundle())
    }

    /** An import finished and the phone has no working system voice for its language. See [LanguageAnalytics.noVoice]. */
    fun logLangNoVoice(language: String, voiceExists: Boolean, deviceLanguage: String) {
        logEvent("lang_no_voice", LanguageAnalytics.noVoice(language, voiceExists, deviceLanguage).toBundle())
    }

    /** The user chose a reading language for a document ([to] null = back to automatic). */
    fun logLangOverride(from: String?, to: String?) {
        logEvent("lang_override", LanguageAnalytics.override(from, to).toBundle())
    }

    private fun Map<String, String>.toBundle(): Bundle = Bundle().also { b -> forEach { (k, v) -> b.putString(k, v) } }

    /**
     * One read through the speech source chain. Source names, reasons and timings only; never any text.
     * Funnel: tts_session (first_source) -> tts_fallback (reason) when the first choice did not work.
     */
    fun logTtsSession(r: com.listenai.service.tts.chain.SessionReport) {
        val firstFallback = r.fallbackReasons.firstOrNull()
        logEvent("tts_session", Bundle().apply {
            putString("first_source", r.firstSource?.name ?: "none")
            putLong("ttfa_ms", r.timeToFirstAudioMs ?: -1L)
            putLong("total_ms", r.totalMs)
            putLong("audio_ms", r.audioMs)
            putLong("chunks", r.chunks.toLong())
            putLong("cache_hits", r.cacheHits.toLong())
            putLong("chars", r.chars.toLong())
            putString("content_language", r.language)
            putString("succeeded", r.succeeded.toString())
        })
        if (firstFallback != null) {
            logEvent("tts_fallback", Bundle().apply {
                putString("from_source", firstFallback.first.name)
                putString("reason", firstFallback.second.name)
                putString("first_source", r.firstSource?.name ?: "none")
                putString("content_language", r.language)
            })
        }
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
