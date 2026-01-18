package com.listenai.data.repository

import android.content.Context
import android.speech.tts.TextToSpeech
import com.listenai.data.models.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale

class VoiceRepository(
    private val context: Context
) {
    private val _availableVoices = MutableStateFlow<List<VoicePreset>>(emptyList())
    val availableVoices: StateFlow<List<VoicePreset>> = _availableVoices.asStateFlow()

    private val _selectedVoice = MutableStateFlow(VoicePreset.narrator)
    val selectedVoice: StateFlow<VoicePreset> = _selectedVoice.asStateFlow()

    private var tts: TextToSpeech? = null
    private var isInitialized = false

    init {
        initializeTTS()
    }

    private fun initializeTTS() {
        tts = TextToSpeech(context) { status ->
            if (status == TextToSpeech.SUCCESS) {
                isInitialized = true
                loadVoices()
            }
        }
    }

    private fun loadVoices() {
        val voices = mutableListOf<VoicePreset>()

        // Add built-in character voices
        voices.addAll(VoicePreset.builtInVoices)

        // Add Android system voices
        tts?.voices?.forEach { voice ->
            if (voice.locale.language == "en") {
                val preset = VoicePreset(
                    id = "android_${voice.name}",
                    name = formatVoiceName(voice.name),
                    isBuiltIn = false,
                    provider = VoiceProvider.ANDROID,
                    providerVoiceId = voice.name,
                    gender = guessGender(voice.name),
                    style = VoiceStyle.NEUTRAL,
                    category = VoiceCategory.NARRATOR,
                    tier = VoiceTier.FREE,
                    languageCode = voice.locale.toLanguageTag(),
                    supportedLanguages = listOf(voice.locale.toLanguageTag())
                )
                voices.add(preset)
            }
        }

        _availableVoices.value = voices.distinctBy { it.id }
    }

    private fun formatVoiceName(voiceName: String): String {
        return voiceName
            .replace("en-us-x-", "")
            .replace("en-gb-x-", "")
            .replace("-local", "")
            .replace("-network", "")
            .split("#")
            .lastOrNull()
            ?.replace("_", " ")
            ?.replaceFirstChar { it.uppercase() }
            ?: voiceName
    }

    private fun guessGender(voiceName: String): VoiceGender {
        return when {
            voiceName.contains("female", ignoreCase = true) -> VoiceGender.FEMALE
            voiceName.contains("male", ignoreCase = true) -> VoiceGender.MALE
            else -> VoiceGender.NEUTRAL
        }
    }

    fun selectVoice(voice: VoicePreset) {
        _selectedVoice.value = voice
    }

    fun getVoiceById(id: String): VoicePreset? {
        return _availableVoices.value.find { it.id == id }
    }

    fun getVoicesByTier(tier: VoiceTier): List<VoicePreset> {
        return _availableVoices.value.filter { it.tier == tier }
    }

    fun getVoicesByCategory(category: VoiceCategory): List<VoicePreset> {
        return _availableVoices.value.filter { it.category == category }
    }

    fun getFreeVoices(): List<VoicePreset> {
        return _availableVoices.value.filter { it.tier == VoiceTier.FREE }
    }

    fun getPremiumVoices(): List<VoicePreset> {
        return _availableVoices.value.filter { it.tier == VoiceTier.PREMIUM }
    }

    fun getCharacterVoices(): List<VoicePreset> {
        return _availableVoices.value.filter { it.isCharacterVoice }
    }

    fun getOnDeviceVoices(): List<VoicePreset> {
        return _availableVoices.value.filter { !it.provider.isCloud }
    }

    fun getCloudVoices(): List<VoicePreset> {
        return _availableVoices.value.filter { it.provider.isCloud }
    }

    fun refreshVoices() {
        if (isInitialized) {
            loadVoices()
        }
    }

    fun cleanup() {
        tts?.shutdown()
        tts = null
    }
}
