package com.listenai.ui.onboarding

import android.content.Context
import android.media.MediaPlayer
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import com.listenai.R

/**
 * Audio player for playing voice samples during onboarding.
 * Uses bundled audio samples for instant playback without network calls.
 */
class OnboardingAudioPlayer(private val context: Context) {

    companion object {
        private const val TAG = "OnboardingAudioPlayer"

        // Mapping from Kokoro voice IDs to raw resource IDs
        private val voiceSampleResources = mapOf(
            // Kokoro voice ID mappings
            "am_adam" to R.raw.voice_sample_adam,
            "af_bella" to R.raw.voice_sample_bella,
            "af_sarah" to R.raw.voice_sample_bella,  // Sarah uses Bella sample
            "af_nicole" to R.raw.voice_sample_rachel,
            "am_michael" to R.raw.voice_sample_josh,
            "af_sky" to R.raw.voice_sample_charlotte,
            "af_heart" to R.raw.voice_sample_bella,  // Heart uses Bella sample
            "bm_george" to R.raw.voice_sample_brian,
            "bf_emma" to R.raw.voice_sample_charlotte,
            // Android preset ID mappings (for direct lookup)
            "narrator" to R.raw.voice_sample_adam,         // Narrator uses Adam
            "calm_teacher" to R.raw.voice_sample_bella,    // Calm Teacher uses Bella/Sarah
            "nicole" to R.raw.voice_sample_rachel,         // Nicole uses Rachel
            "storyteller" to R.raw.voice_sample_charlotte, // Storyteller uses Charlotte/Sky
            "news_anchor" to R.raw.voice_sample_josh,      // News Anchor uses Josh/Michael
            "warm_narrator" to R.raw.voice_sample_bella,   // Warm Narrator uses Bella/Heart
            // Direct name mappings as fallbacks
            "adam" to R.raw.voice_sample_adam,
            "bella" to R.raw.voice_sample_bella,
            "brian" to R.raw.voice_sample_brian,
            "josh" to R.raw.voice_sample_josh,
            "charlotte" to R.raw.voice_sample_charlotte,
            "rachel" to R.raw.voice_sample_rachel
        )
    }

    // State
    private val _isPlaying = MutableStateFlow(false)
    val isPlaying: StateFlow<Boolean> = _isPlaying.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _currentVoiceId = MutableStateFlow<String?>(null)
    val currentVoiceId: StateFlow<String?> = _currentVoiceId.asStateFlow()

    private var mediaPlayer: MediaPlayer? = null

    /**
     * Play sample audio for a voice using bundled audio files.
     * @param voiceId The voice ID (Kokoro ID or voice name)
     */
    fun play(voiceId: String) {
        // Stop any currently playing audio
        stop()

        _currentVoiceId.value = voiceId
        _isLoading.value = true

        // Look up the resource for this voice
        val resourceId = voiceSampleResources[voiceId]
            ?: voiceSampleResources[voiceId.lowercase()]

        if (resourceId == null) {
            Log.w(TAG, "No bundled sample for voice ID: $voiceId")
            Log.d(TAG, "Available voice IDs: ${voiceSampleResources.keys}")
            _currentVoiceId.value = null
            _isLoading.value = false
            return
        }

        try {
            Log.d(TAG, "Playing bundled sample for voice: $voiceId (resource: $resourceId)")

            mediaPlayer = MediaPlayer.create(context, resourceId)?.apply {
                setOnCompletionListener {
                    Log.d(TAG, "Playback completed for voice: $voiceId")
                    _isPlaying.value = false
                    _currentVoiceId.value = null
                }
                setOnErrorListener { _, what, extra ->
                    Log.e(TAG, "MediaPlayer error: what=$what, extra=$extra")
                    _isPlaying.value = false
                    _currentVoiceId.value = null
                    _isLoading.value = false
                    true
                }
                setOnPreparedListener {
                    Log.d(TAG, "MediaPlayer prepared, starting playback")
                    _isLoading.value = false
                    _isPlaying.value = true
                    start()
                }
            }

            if (mediaPlayer == null) {
                Log.e(TAG, "Failed to create MediaPlayer for resource: $resourceId")
                _currentVoiceId.value = null
                _isLoading.value = false
            }

        } catch (e: Exception) {
            Log.e(TAG, "Error playing bundled file", e)
            _currentVoiceId.value = null
            _isLoading.value = false
        }
    }

    /**
     * Stop playback
     */
    fun stop() {
        try {
            mediaPlayer?.apply {
                if (isPlaying) {
                    stop()
                }
                release()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping MediaPlayer", e)
        }
        mediaPlayer = null
        _isLoading.value = false
        _isPlaying.value = false
        _currentVoiceId.value = null
    }

    /**
     * Toggle playback for a voice
     */
    fun toggle(voiceId: String) {
        if (_currentVoiceId.value == voiceId && (_isPlaying.value || _isLoading.value)) {
            stop()
        } else {
            play(voiceId)
        }
    }

    /**
     * Release all resources
     */
    fun release() {
        stop()
    }
}
