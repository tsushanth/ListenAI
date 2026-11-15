package com.listenai.service.tts

import android.content.Context
import android.content.SharedPreferences
import com.listenai.service.LanguageDetector
import com.listenai.service.tts.chain.LanguageKey

/** Tiny key-value seam so the preference logic is unit tested without Android. */
interface KeyValueStore {
    fun get(key: String): String?
    /** A null [value] removes the key. */
    fun put(key: String, value: String?)
}

class SharedPrefsStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String?) {
        prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }
}

/**
 * What the user chose, kept on the device only: the reading language of one document ("override", absent = automatic)
 * and, per language, which system voice to use. Keys are document ids and language codes, never text.
 */
class LanguagePrefs(private val store: KeyValueStore) {

    fun override(articleId: String): String? = store.get(OVERRIDE_PREFIX + articleId)?.takeIf { it.isNotBlank() }

    /** A null [code] puts the document back on automatic detection. */
    fun setOverride(articleId: String, code: String?) {
        store.put(OVERRIDE_PREFIX + articleId, code?.let { LanguageChoice.normalize(it) })
    }

    /** The voice name the user picked for [language], or null for "best available". */
    fun preferredVoice(language: String): String? = store.get(VOICE_PREFIX + LanguageChoice.normalize(language))?.takeIf { it.isNotBlank() }

    /** Picking a phone voice replaces a ReadAloud voice pick for the language: the picker holds one choice per language. */
    fun setPreferredVoice(language: String, voiceName: String?) {
        store.put(VOICE_PREFIX + LanguageChoice.normalize(language), voiceName)
        if (voiceName != null) store.put(CLOUD_VOICE_PREFIX + LanguageChoice.normalize(language), null)
    }

    /** The ReadAloud voice id the user picked for [language] (a non-English language), or null for the default. */
    fun preferredCloudVoice(language: String): String? =
        store.get(CLOUD_VOICE_PREFIX + LanguageChoice.normalize(language))?.takeIf { it.isNotBlank() }

    /** Picking a ReadAloud voice replaces a phone voice pick for the language. A null [voiceId] clears the ReadAloud pick only. */
    fun setPreferredCloudVoice(language: String, voiceId: String?) {
        store.put(CLOUD_VOICE_PREFIX + LanguageChoice.normalize(language), voiceId)
        if (voiceId != null) store.put(VOICE_PREFIX + LanguageChoice.normalize(language), null)
    }

    /**
     * The default ReadAloud voice of [language] as first seen on this phone, so a server-side reorder of the voice list does not
     * silently give the language another voice from one read to the next. Not a user pick (the picker keeps showing "Automatic").
     */
    fun defaultCloudVoice(language: String): String? =
        store.get(CLOUD_DEFAULT_PREFIX + LanguageChoice.normalize(language))?.takeIf { it.isNotBlank() }

    fun setDefaultCloudVoice(language: String, voiceId: String?) {
        store.put(CLOUD_DEFAULT_PREFIX + LanguageChoice.normalize(language), voiceId)
    }

    /**
     * The ReadAloud voice that reads [language] for the voices [listed]: the user's pick, else the stored default, else the
     * first offered one (see CloudVoicePolicy). A pick or default that the list no longer offers for the language is dropped. The first-seen default (and a replacement when the stored one is no longer offered) is stored. Null when the
     * cloud has no voice for the language.
     */
    fun resolveCloudVoice(language: String, listed: List<com.listenai.service.tts.chain.CloudVoice>): com.listenai.service.tts.chain.CloudVoice? {
        val offered = com.listenai.service.tts.chain.CloudVoicePolicy.voicesFor(language, listed)
        if (offered.isEmpty()) return null
        // A voice id the list does not offer for this language is never sent: the worker answers an unknown id with audio from a default voice.
        var pick = preferredCloudVoice(language)
        if (pick != null && offered.none { it.id == pick }) { setPreferredCloudVoice(language, null); pick = null }
        val stored = defaultCloudVoice(language)?.takeIf { id -> offered.any { it.id == id } }
        val chosen = offered.firstOrNull { it.id == pick } ?: offered.firstOrNull { it.id == stored } ?: offered.first()
        if (pick == null && stored != chosen.id) setDefaultCloudVoice(language, chosen.id)
        return chosen
    }

    companion object {
        private const val CLOUD_DEFAULT_PREFIX = "clouddefault_"
        private const val FILE = "language_prefs"
        private const val OVERRIDE_PREFIX = "override_"
        private const val VOICE_PREFIX = "voice_"
        private const val CLOUD_VOICE_PREFIX = "cloudvoice_"

        fun get(context: Context): LanguagePrefs =
            LanguagePrefs(SharedPrefsStore(context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)))
    }
}

/** Pure rules for which language a document is read in. */
object LanguageChoice {

    /** "es-MX" and "ES" become "es". */
    fun normalize(code: String): String = LanguageKey.of(code)

    /** The user's pick beats detection; detection beats what is stored; English is the last resort. */
    fun resolve(override: String?, detected: String?, stored: String?): String =
        override?.takeIf { it.isNotBlank() }?.let { normalize(it) }
            ?: detected?.takeIf { it.isNotBlank() }?.let { normalize(it) }
            ?: stored?.takeIf { it.isNotBlank() }?.let { normalize(it) }
            ?: LanguageDetector.DEFAULT

    /** Re-run detection only when the user has not chosen a language. */
    fun shouldRedetect(override: String?): Boolean = override.isNullOrBlank()

    /**
     * The languages offered in the menu: what the phone can speak, plus the current choice and the detected one so the
     * selected entry is always visible, sorted by [nameOf] (the name in the user's language).
     */
    fun menuLanguages(speakable: Collection<String>, detected: String?, override: String?, nameOf: (String) -> String): List<String> {
        val all = LinkedHashSet<String>()
        speakable.forEach { if (it.isNotBlank()) all += normalize(it) }
        detected?.takeIf { it.isNotBlank() }?.let { all += normalize(it) }
        override?.takeIf { it.isNotBlank() }?.let { all += normalize(it) }
        return all.sortedBy { nameOf(it).lowercase() }
    }
}
