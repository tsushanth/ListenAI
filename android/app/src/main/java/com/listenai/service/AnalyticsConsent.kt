package com.listenai.service

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Where the consent choice is persisted. Split out so the logic can be unit tested without Android. */
interface ConsentStore {
    /** Stored choice: 0 = not asked yet, 1 = allowed, 2 = declined. */
    fun read(): Int
    fun write(value: Int)
}

enum class ConsentState { UNSET, GRANTED, DECLINED }

/**
 * Opt-in consent for Firebase Analytics, the only analytics SDK in the reader flavor.
 * Nothing is collected until [setGranted] (true) is called from an explicit user choice.
 * [onChanged] is invoked with the new "collection allowed" value on every change.
 */
class AnalyticsConsentManager(
    private val store: ConsentStore,
    private val onChanged: (Boolean) -> Unit
) {
    private val _state = MutableStateFlow(decode(store.read()))
    val state: StateFlow<ConsentState> = _state.asStateFlow()

    val isGranted: Boolean get() = _state.value == ConsentState.GRANTED

    fun setGranted(granted: Boolean) {
        _state.value = if (granted) ConsentState.GRANTED else ConsentState.DECLINED
        store.write(if (granted) 1 else 2)
        onChanged(granted)
    }

    /** Re-applies the stored choice (call once at startup). Unset and declined both mean OFF. */
    fun applyStored() = onChanged(isGranted)

    private fun decode(v: Int) = when (v) {
        1 -> ConsentState.GRANTED
        2 -> ConsentState.DECLINED
        else -> ConsentState.UNSET
    }
}

/** App-wide instance, created in [com.listenai.ListenAIApplication] (reader flavor only). */
object AnalyticsConsent {
    private const val PREFS = "analytics_consent"
    private const val KEY = "choice"

    @Volatile
    private var manager: AnalyticsConsentManager? = null

    fun init(context: Context) {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val store = object : ConsentStore {
            override fun read() = prefs.getInt(KEY, 0)
            override fun write(value: Int) { prefs.edit().putInt(KEY, value).apply() }
        }
        manager = AnalyticsConsentManager(store) { FirebaseAnalyticsHelper.applyConsent(it) }
            .also { it.applyStored() }
    }

    /** Null in the voice flavor, which never calls [init] and has no analytics. */
    fun get(): AnalyticsConsentManager? = manager
}
