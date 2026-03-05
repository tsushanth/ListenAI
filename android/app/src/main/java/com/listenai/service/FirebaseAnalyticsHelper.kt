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

    fun initialize(context: Context) {
        try {
            firebaseAnalytics = Firebase.analytics
            isInitialized = true
            Log.d(TAG, "Firebase Analytics initialized")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize Firebase Analytics: ${e.message}")
        }
    }

    fun setUserId(userId: String?) {
        firebaseAnalytics?.setUserId(userId)
    }

    fun setUserProperty(name: String, value: String?) {
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

    fun logContentImported(importMode: String) {
        val params = Bundle().apply {
            putString("import_mode", importMode) // url, document, text, clipboard, email
        }
        logEvent("content_imported", params)
    }

    fun logImportFailed(importMode: String, error: String? = null) {
        val params = Bundle().apply {
            putString("import_mode", importMode)
            error?.let { putString("error", it) }
        }
        logEvent("import_failed", params)
    }

    // Playback Events

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
        try {
            firebaseAnalytics?.logEvent(eventName, params)
            Log.d(TAG, "Logged event: $eventName")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to log event $eventName: ${e.message}")
        }
    }
}
