package com.listenai.service.fakedoor

import android.content.Context

/**
 * "Offline voice + custom pronunciation" fake door (experiment; flag OFF by default).
 *
 * The feature does NOT exist. This only measures interest. Nothing is downloaded, sold or charged, and
 * the screen says so. The flag and consent rules below are plain Kotlin (no Android types) so they
 * can be unit tested on the JVM.
 */
object OfflineVoiceFakeDoor {
    /** Planned price shown on the screen. A plan, not an offer: no payment flow exists. */
    const val PLANNED_PRICE_USD = "$6.99"

    const val EVENT_OPENED = "offline_voice_door_opened"
    const val EVENT_NOTIFY = "offline_voice_door_notify_me"

    /**
     * The entry is shown only if the flag is on, and only in the reader flavor. The flag is the build
     * flag (default OFF) OR a server flag (default OFF, absent from the server today).
     */
    fun isVisible(buildFlag: Boolean, remoteFlag: Boolean, isVoiceFlavor: Boolean): Boolean =
        !isVoiceFlavor && (buildFlag || remoteFlag)
}

/** Where the "notify me" choice lives. A local flag only: nothing leaves the device. */
interface InterestStore {
    fun isInterested(): Boolean
    fun setInterested(value: Boolean)
}

/** Sends an analytics event. The real implementation is Firebase, which has its own consent gate too. */
fun interface FakeDoorEventSink {
    fun log(event: String)
}

/**
 * Applies the rules for the fake door: events are logged only while analytics consent is ON (checked at
 * call time, so a later opt-out takes effect immediately), and "notify me" is an explicit action that
 * only sets a local flag. The notify-me flag does not depend on analytics consent, because it never
 * leaves the device.
 */
class FakeDoorController(
    private val store: InterestStore,
    private val analyticsGranted: () -> Boolean,
    private val sink: FakeDoorEventSink
) {
    val interested: Boolean get() = store.isInterested()

    fun onOpened() = logIfConsented(OfflineVoiceFakeDoor.EVENT_OPENED)

    /** Explicit tap on "Notify me". Returns the new state. */
    fun onNotifyMe(): Boolean {
        val firstTime = !store.isInterested()
        store.setInterested(true)
        if (firstTime) logIfConsented(OfflineVoiceFakeDoor.EVENT_NOTIFY)
        return true
    }

    /** "Remove me": clears the local flag. */
    fun onWithdraw() = store.setInterested(false)

    private fun logIfConsented(event: String) {
        if (analyticsGranted()) sink.log(event)
    }
}

/** SharedPreferences-backed [InterestStore]. */
class PrefsInterestStore(context: Context) : InterestStore {
    private val prefs = context.applicationContext.getSharedPreferences("offline_voice_fake_door", Context.MODE_PRIVATE)
    override fun isInterested() = prefs.getBoolean("notify_me", false)
    override fun setInterested(value: Boolean) { prefs.edit().putBoolean("notify_me", value).apply() }
}

/** Optional server flag, cached from `GET /api/config` by PaywallRemoteConfig. Absent means OFF. */
object FakeDoorRemoteFlag {
    private const val PREFS = "offline_voice_fake_door_remote"
    private const val KEY = "enabled"

    fun isOn(context: Context): Boolean =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, false)

    fun store(context: Context, enabled: Boolean) {
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, enabled).apply()
    }
}
