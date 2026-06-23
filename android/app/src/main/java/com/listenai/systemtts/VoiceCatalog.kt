package com.listenai.systemtts

import android.content.Context
import android.speech.tts.Voice
import android.util.Log
import com.listenai.data.models.VoiceCategory
import com.listenai.data.models.VoiceGender
import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceProvider
import com.listenai.data.models.VoiceQuality
import com.listenai.data.models.VoiceStyle
import com.listenai.data.models.VoiceTier
import com.listenai.service.voice.VoiceCloningService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference

/**
 * Maps ReadAloud's [VoicePreset]s — both **built-in** Kokoro voices and the
 * user's **cloned** voices — to the system Android TTS [Voice] descriptors
 * other apps (TalkBack, Maps, Kindle…) will see.
 *
 * System voice name format:
 *   - Built-in:   `readaloud-<presetId>-<lang>-<region>`     e.g. `readaloud-rachel-en-us`
 *   - Cloned:     `readaloud-cloned-<voiceId>-<lang>-<region>` e.g. `readaloud-cloned-abc123-en-us`
 *
 * Cloned voices are fetched asynchronously and cached because the system TTS
 * framework calls `onGetVoices()` synchronously — there's no suspend hook.
 * First call may return an empty/stale clone list; subsequent calls will pick
 * up the refresh.
 *
 * Day-2 (M2 + M2.5) — English-only. M5 adds multi-locale once Kokoro
 * multilingual is production-ready.
 */
object VoiceCatalog {

    private const val TAG = "VoiceCatalog"
    private const val NAME_PREFIX = "readaloud-"
    private const val CLONED_PREFIX = "readaloud-cloned-"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Snapshot of the most recently fetched cloned voices. */
    private val clonedVoiceCache = AtomicReference<List<VoiceCloningService.ClonedVoice>>(emptyList())

    /**
     * Kokoro voice embeddings shipped in `res/raw/kokoro_voice_*` and read by
     * [com.listenai.service.tts.KokoroG2P.loadVoicePack]. Any preset whose
     * `providerVoiceId` is NOT in this set silently falls back to `af_heart`
     * (female warm) inside the G2P — so we filter those presets out of the
     * catalog entirely to avoid the "Adam sounds female" surprise.
     *
     * Adding more voices = bundle the corresponding `.bin` in `res/raw` and
     * add the ID here. Voice packs are ~500 KB each. Long-term these become
     * M4 paid voice packs (download-on-demand via RevenueCat).
     */
    private val bundledKokoroVoiceIds = setOf(
        "af_heart",
        "af_bella",
        "am_michael",
        "bm_george",
        "bf_emma",
    )

    /**
     * Built-in voices exposed as system voices. We expose only the presets
     * whose Kokoro voice ID is actually bundled in res/raw — see
     * [bundledKokoroVoiceIds].
     */
    private val builtInPresets: List<VoicePreset> by lazy {
        VoicePreset.run {
            listOfNotNull(
                runCatching { rachel }.getOrNull(),
                runCatching { adam }.getOrNull(),
                runCatching { bella }.getOrNull(),
                runCatching { josh }.getOrNull(),
                runCatching { brian }.getOrNull(),
                runCatching { charlotte }.getOrNull(),
                runCatching { elli }.getOrNull(),
                runCatching { bill }.getOrNull(),
                runCatching { matilda }.getOrNull(),
                runCatching { dorothy }.getOrNull(),
            ).filter { preset ->
                val voiceId = preset.providerVoiceId
                voiceId != null && voiceId in bundledKokoroVoiceIds
            }
                // Dedupe: multiple presets may share the same Kokoro voice
                // (e.g. Josh + Bill both map to am_michael). Keep the first.
                .distinctBy { it.providerVoiceId }
        }
    }

    /**
     * Trigger a background refresh of the cloned voices list from
     * [VoiceCloningService]. Fire-and-forget — the next `onGetVoices()`
     * call after completion will include the updated set.
     */
    fun refreshClonedVoices(context: Context) {
        scope.launch {
            try {
                val service = VoiceCloningService.getInstance(context)
                if (!service.isConfigured) {
                    Log.w(TAG, "VoiceCloningService not configured yet — skip refresh")
                    return@launch
                }
                val clones = service.listClonedVoices()
                clonedVoiceCache.set(clones)
                Log.i(TAG, "Cloned voice cache refreshed: ${clones.size} voices")
            } catch (t: Throwable) {
                Log.w(TAG, "Cloned voice refresh failed: ${t.message}")
            }
        }
    }

    /**
     * All [Voice] descriptors to expose to the Android TTS framework — both
     * built-in and the currently-cached set of cloned voices.
     */
    fun systemVoices(): MutableList<Voice> {
        val voices = mutableListOf<Voice>()
        for (preset in builtInPresets) {
            voices += buildSystemVoiceFor(preset, requiresNetwork = !isOnDeviceProvider(preset))
        }
        for (cloned in readyClones()) {
            voices += buildSystemVoiceForCloned(cloned)
        }
        return voices
    }

    /** Default voice for a given locale. Falls back to the first built-in. */
    fun defaultVoiceName(lang: String?, country: String?, variant: String?): String {
        val target = (lang ?: "en").lowercase()
        val match = builtInPresets.firstOrNull {
            parseLanguageTag(it.languageCode).first.equals(target, ignoreCase = true)
        } ?: builtInPresets.firstOrNull()
        val (la, re) = parseLanguageTag(match?.languageCode ?: "en-US")
        return systemNameFor(match?.id ?: "rachel", la, re)
    }

    /**
     * Resolve a preset id (as stored in `SettingsManager.selectedVoiceId`)
     * to the system voice name format Android expects from
     * `onGetDefaultVoiceNameFor()`. Returns null when the id doesn't
     * match a built-in voice (e.g., the user previously picked a cloned
     * voice but it was deleted; or a stale preference from before a
     * catalog change). Caller should fall back to [defaultVoiceName].
     */
    fun voiceNameForPresetId(presetId: String?): String? {
        if (presetId.isNullOrBlank()) return null
        val preset = builtInPresets.firstOrNull { it.id == presetId } ?: return null
        val (la, re) = parseLanguageTag(preset.languageCode)
        return systemNameFor(preset.id, la, re)
    }

    /** True if [voiceName] resolves to a known built-in or cloned voice. */
    fun isValid(voiceName: String?): Boolean {
        voiceName ?: return false
        return resolvePreset(voiceName) != null
    }

    /**
     * Resolves a system voice name back to a [VoicePreset] for synthesis.
     *
     * - Built-in: looks up the preset in [builtInPresets]
     * - Cloned:   constructs a synthetic [VoicePreset] from cached ClonedVoice metadata
     *
     * Returns null if unknown.
     */
    fun resolvePreset(voiceName: String): VoicePreset? {
        if (!voiceName.startsWith(NAME_PREFIX)) return null

        // Cloned namespace: readaloud-cloned-<voiceId>-<lang>-<region>
        if (voiceName.startsWith(CLONED_PREFIX)) {
            val tail = voiceName.removePrefix(CLONED_PREFIX)
            val parts = tail.split("-")
            if (parts.size < 3) return null
            // voice IDs can contain dashes — peel off the trailing <lang>-<region>
            val voiceId = parts.dropLast(2).joinToString("-")
            val cloned = clonedVoiceCache.get().firstOrNull { it.id == voiceId } ?: return null
            return clonedToVoicePreset(cloned)
        }

        // Built-in: readaloud-<id>-<lang>-<region>
        val tail = voiceName.removePrefix(NAME_PREFIX)
        val parts = tail.split("-")
        if (parts.size < 3) return null
        val presetId = parts.dropLast(2).joinToString("-")
        return builtInPresets.firstOrNull { it.id.equals(presetId, ignoreCase = true) }
    }

    /** Returns true if [lang] is supported by any built-in voice. */
    fun languageSupported(lang: String?): Boolean {
        lang ?: return false
        val want = lang.lowercase()
        return builtInPresets.any {
            parseLanguageTag(it.languageCode).first.equals(want, ignoreCase = true)
        }
    }

    /** Returns true if a specific country variant is supported for [lang]. */
    fun languageCountrySupported(lang: String?, country: String?): Boolean {
        lang ?: return false
        country ?: return false
        return builtInPresets.any {
            val (l, r) = parseLanguageTag(it.languageCode)
            l.equals(lang, ignoreCase = true) && r.equals(country, ignoreCase = true)
        }
    }

    /** All built-in presets (for the Settings catalog UI). */
    fun presets(): List<VoicePreset> = builtInPresets

    /** Currently cached cloned voices that are ready for synthesis. */
    fun clonedVoices(): List<VoiceCloningService.ClonedVoice> = readyClones()

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private fun readyClones(): List<VoiceCloningService.ClonedVoice> {
        return clonedVoiceCache.get().filter { it.isReady }
    }

    /**
     * Wrap a ClonedVoice as a VoicePreset routed through the chatterbox
     * provider so TTSCoordinator's `isClonedVoice` check fires (it looks for
     * `providerModelId == "chatterbox"` or an id starting with "cloned_").
     */
    private fun clonedToVoicePreset(c: VoiceCloningService.ClonedVoice): VoicePreset {
        return VoicePreset(
            id = "cloned_${c.id}",
            name = c.name,
            isBuiltIn = false,
            provider = VoiceProvider.SELF_HOSTED,
            providerVoiceId = c.id,
            providerModelId = "chatterbox",
            quality = VoiceQuality.STANDARD,
            kokoroVoiceId = null,
            gender = VoiceGender.NEUTRAL,
            style = VoiceStyle.NEUTRAL,
            category = VoiceCategory.NARRATOR,
            tier = VoiceTier.PREMIUM,
            languageCode = "en-US",
            supportedLanguages = listOf("en-US"),
            sampleAudioUrl = c.audioUrl,
            sampleText = "This is a sample of ${c.name}.",
            avatarEmoji = "🎤",   // 🎤 mic
            accentColorHex = "#7C3AED"      // violet
        )
    }

    private fun buildSystemVoiceFor(preset: VoicePreset, requiresNetwork: Boolean): Voice {
        val (lang, region) = parseLanguageTag(preset.languageCode)
        val locale = Locale(lang, region)
        return Voice(
            systemNameFor(preset.id, lang, region),
            locale,
            Voice.QUALITY_NORMAL,
            if (requiresNetwork) Voice.LATENCY_HIGH else Voice.LATENCY_NORMAL,
            requiresNetwork,
            emptySet()
        )
    }

    private fun buildSystemVoiceForCloned(c: VoiceCloningService.ClonedVoice): Voice {
        // Cloned voices currently round-trip to the chatterbox backend, so they
        // always require network. M3 (on-device cloning) flips this to false.
        val name = "$CLONED_PREFIX${c.id.lowercase()}-en-us"
        return Voice(
            name,
            Locale.US,
            Voice.QUALITY_NORMAL,
            Voice.LATENCY_VERY_HIGH,  // 1-3 s round-trip to chatterbox
            /* requiresNetworkConnection = */ true,
            emptySet()
        )
    }

    private fun isOnDeviceProvider(preset: VoicePreset): Boolean {
        // SELF_HOSTED and ANDROID can route to the on-device Kokoro path once
        // M3 lands. Until then, mark all as requiring network EXCEPT explicitly
        // local Android-system fallbacks.
        return preset.provider.name == "ANDROID"
    }

    private fun systemNameFor(presetId: String, lang: String, region: String): String {
        return "$NAME_PREFIX${presetId.lowercase()}-${lang.lowercase()}-${region.lowercase()}"
    }

    /** "en-US" → ("en", "US"); "en" → ("en", "US"). */
    private fun parseLanguageTag(tag: String): Pair<String, String> {
        val parts = tag.split("-", "_")
        return when (parts.size) {
            1 -> parts[0] to "US"
            else -> parts[0] to parts[1]
        }
    }
}
