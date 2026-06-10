package com.listenai.service.settings

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Manages app settings with persistence via SharedPreferences
 */
class SettingsManager(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    // Playback Settings
    private val _playbackSpeed = MutableStateFlow(prefs.getFloat(KEY_PLAYBACK_SPEED, DEFAULT_PLAYBACK_SPEED))
    val playbackSpeed: StateFlow<Float> = _playbackSpeed.asStateFlow()

    private val _skipInterval = MutableStateFlow(prefs.getInt(KEY_SKIP_INTERVAL, DEFAULT_SKIP_INTERVAL))
    val skipInterval: StateFlow<Int> = _skipInterval.asStateFlow()

    private val _sleepTimerDefault = MutableStateFlow(prefs.getInt(KEY_SLEEP_TIMER_DEFAULT, DEFAULT_SLEEP_TIMER))
    val sleepTimerDefault: StateFlow<Int> = _sleepTimerDefault.asStateFlow()

    // Appearance Settings
    private val _appearanceMode = MutableStateFlow(prefs.getString(KEY_APPEARANCE_MODE, DEFAULT_APPEARANCE_MODE) ?: DEFAULT_APPEARANCE_MODE)
    val appearanceMode: StateFlow<String> = _appearanceMode.asStateFlow()

    // Voice Settings
    private val _selectedVoiceId = MutableStateFlow(prefs.getString(KEY_SELECTED_VOICE_ID, null))
    val selectedVoiceId: StateFlow<String?> = _selectedVoiceId.asStateFlow()

    // ---- On-device Kokoro (Android v2 path) ----------------------------------
    // The onboarding picker presents two options: Cloud Kokoro vs On-device
    // Kokoro. The user's pick is stored as `useOfflineKokoro` and consulted
    // at TTS dispatch time. When false → cloud (selfhosted listenai-tts-worker).
    // When true AND the model has been downloaded → on-device ONNX. If the
    // model isn't ready yet, TTSServiceFactory transparently falls back to
    // cloud so the picker is honest *and* the app keeps working.
    private val _useOfflineKokoro = MutableStateFlow(prefs.getBoolean(KEY_USE_OFFLINE_KOKORO, false))
    val useOfflineKokoro: StateFlow<Boolean> = _useOfflineKokoro.asStateFlow()

    // Cellular download policy for the ~80 MB Kokoro model. Default off; we
    // wait for WiFi.
    private val _allowCellularModelDownload = MutableStateFlow(prefs.getBoolean(KEY_ALLOW_CELLULAR_DOWNLOAD, false))
    val allowCellularModelDownload: StateFlow<Boolean> = _allowCellularModelDownload.asStateFlow()

    /**
     * Set playback speed (0.5x to 2.0x)
     */
    fun setPlaybackSpeed(speed: Float) {
        val clampedSpeed = speed.coerceIn(0.5f, 2.0f)
        _playbackSpeed.value = clampedSpeed
        prefs.edit().putFloat(KEY_PLAYBACK_SPEED, clampedSpeed).apply()
    }

    /**
     * Set skip interval in seconds (5, 10, 15, 30, 60)
     */
    fun setSkipInterval(seconds: Int) {
        _skipInterval.value = seconds
        prefs.edit().putInt(KEY_SKIP_INTERVAL, seconds).apply()
    }

    /**
     * Set default sleep timer duration in minutes (0 = off, 15, 30, 45, 60)
     */
    fun setSleepTimerDefault(minutes: Int) {
        _sleepTimerDefault.value = minutes
        prefs.edit().putInt(KEY_SLEEP_TIMER_DEFAULT, minutes).apply()
    }

    /**
     * Set appearance mode ("System", "Light", "Dark")
     */
    fun setAppearanceMode(mode: String) {
        _appearanceMode.value = mode
        prefs.edit().putString(KEY_APPEARANCE_MODE, mode).apply()
    }

    /**
     * Set selected voice ID
     */
    fun setSelectedVoiceId(voiceId: String?) {
        _selectedVoiceId.value = voiceId
        if (voiceId != null) {
            prefs.edit().putString(KEY_SELECTED_VOICE_ID, voiceId).apply()
        } else {
            prefs.edit().remove(KEY_SELECTED_VOICE_ID).apply()
        }
    }

    /**
     * Get the formatted display string for playback speed
     */
    fun getPlaybackSpeedDisplay(): String = "${_playbackSpeed.value}x"

    /**
     * Get the formatted display string for skip interval
     */
    fun getSkipIntervalDisplay(): String = "${_skipInterval.value} seconds"

    /**
     * Toggle on-device Kokoro preference. Onboarding writes this from the
     * voice picker; Settings exposes it for later changes.
     */
    fun setUseOfflineKokoro(enabled: Boolean) {
        _useOfflineKokoro.value = enabled
        prefs.edit().putBoolean(KEY_USE_OFFLINE_KOKORO, enabled).apply()
    }

    fun setAllowCellularModelDownload(enabled: Boolean) {
        _allowCellularModelDownload.value = enabled
        prefs.edit().putBoolean(KEY_ALLOW_CELLULAR_DOWNLOAD, enabled).apply()
    }

    /**
     * Get the formatted display string for sleep timer default
     */
    fun getSleepTimerDefaultDisplay(): String = when (_sleepTimerDefault.value) {
        0 -> "Off"
        else -> "${_sleepTimerDefault.value} minutes"
    }

    companion object {
        private const val PREFS_NAME = "listenai_settings"

        // Keys
        private const val KEY_PLAYBACK_SPEED = "playback_speed"
        private const val KEY_SKIP_INTERVAL = "skip_interval"
        private const val KEY_SLEEP_TIMER_DEFAULT = "sleep_timer_default"
        private const val KEY_APPEARANCE_MODE = "appearance_mode"
        private const val KEY_SELECTED_VOICE_ID = "selected_voice_id"
        private const val KEY_USE_OFFLINE_KOKORO = "use_offline_kokoro"
        private const val KEY_ALLOW_CELLULAR_DOWNLOAD = "allow_cellular_model_download"

        // Defaults
        const val DEFAULT_PLAYBACK_SPEED = 1.0f
        const val DEFAULT_SKIP_INTERVAL = 15
        const val DEFAULT_SLEEP_TIMER = 0 // Off by default
        const val DEFAULT_APPEARANCE_MODE = "System"

        @Volatile
        private var instance: SettingsManager? = null

        fun getInstance(context: Context): SettingsManager {
            return instance ?: synchronized(this) {
                instance ?: SettingsManager(context.applicationContext).also { instance = it }
            }
        }
    }
}
