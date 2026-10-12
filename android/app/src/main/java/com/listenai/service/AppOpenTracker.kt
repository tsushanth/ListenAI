package com.listenai.service

import android.content.Context
import android.content.SharedPreferences
import android.util.Log

/**
 * Tracks the number of times the app has been opened (cold starts only).
 * Used to enforce a hard paywall after a configurable number of free opens.
 */
object AppOpenTracker {

    private const val TAG = "AppOpenTracker"
    private const val PREFS_NAME = "app_open_tracker"
    private const val KEY_OPEN_COUNT = "open_count"
    private const val KEY_HAS_LISTENED = "has_listened"
    private const val KEY_LAST_PAYWALL_SHOWN_AT = "last_paywall_shown_at"

    /** Number of free app opens before the hard paywall is shown */
    const val FREE_OPEN_LIMIT = 3

    private var prefs: SharedPreferences? = null
    private var hasIncrementedThisSession = false

    fun init(context: Context) {
        prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    /**
     * Increments the app open count. Should be called once per cold start session.
     * Returns the new count.
     */
    fun incrementOpenCount(): Int {
        if (hasIncrementedThisSession) {
            Log.d(TAG, "Already incremented this session, skipping")
            return getOpenCount()
        }

        val current = getOpenCount()
        val newCount = current + 1
        prefs?.edit()?.putInt(KEY_OPEN_COUNT, newCount)?.apply()
        hasIncrementedThisSession = true
        Log.d(TAG, "App open count incremented to $newCount (limit: $FREE_OPEN_LIMIT)")
        return newCount
    }

    /**
     * Returns the current app open count.
     */
    fun getOpenCount(): Int {
        return prefs?.getInt(KEY_OPEN_COUNT, 0) ?: 0
    }

    /**
     * Returns true if the user has exceeded the free open limit.
     */
    fun hasExceededFreeLimit(): Boolean {
        return getOpenCount() > FREE_OPEN_LIMIT
    }

    /** True once the user has started playing audio at least once. */
    fun hasListened(): Boolean = prefs?.getBoolean(KEY_HAS_LISTENED, false) ?: false

    /** Records the first listen. Returns true only the first time it is called. */
    fun markListened(): Boolean {
        if (hasListened()) return false
        prefs?.edit()?.putBoolean(KEY_HAS_LISTENED, true)?.apply()
        return true
    }

    /** When the paywall was last shown on a cold start, or 0 if never. */
    fun lastPaywallShownAt(): Long = prefs?.getLong(KEY_LAST_PAYWALL_SHOWN_AT, 0L) ?: 0L

    fun markPaywallShown(nowMs: Long = System.currentTimeMillis()) {
        prefs?.edit()?.putLong(KEY_LAST_PAYWALL_SHOWN_AT, nowMs)?.apply()
    }
}
