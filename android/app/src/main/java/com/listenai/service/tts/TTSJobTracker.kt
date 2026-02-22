package com.listenai.service.tts

import android.util.Log
import com.listenai.data.models.VoicePreset
import com.listenai.data.repository.ArticleRepository
import com.listenai.service.notification.TTSNotificationService
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map

private const val TAG = "TTSJobTracker"

data class TrackedJob(
    val articleId: String,
    val voiceId: String,
    val progress: Float = 0f,
    val statusMessage: String = "Preparing...",
    val status: String = "queued", // queued, processing, partial_ready, ready, failed
    val previewUrl: String? = null,
    val previewDurationSec: Double? = null,
    val audioFilePath: String? = null,
    val durationMs: Long = 0
)

/**
 * Singleton that tracks TTS synthesis jobs across navigation.
 * Survives PlayerScreen lifecycle - jobs continue in background.
 */
class TTSJobTracker(
    private val articleRepository: ArticleRepository,
    private val ttsCoordinator: TTSCoordinator,
    private val notificationService: TTSNotificationService
) {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val _jobs = MutableStateFlow<Map<String, TrackedJob>>(emptyMap())
    private val activeCoroutines = mutableMapOf<String, Job>()

    fun getJob(articleId: String): StateFlow<TrackedJob?> {
        // Return a derived flow that maps from the jobs map
        val flow = MutableStateFlow(_jobs.value[articleId])
        scope.launch {
            _jobs.collect { jobs ->
                flow.value = jobs[articleId]
            }
        }
        return flow
    }

    fun isTracking(articleId: String): Boolean {
        return _jobs.value.containsKey(articleId)
    }

    fun getTrackedJob(articleId: String): TrackedJob? {
        return _jobs.value[articleId]
    }

    /**
     * Start synthesis for an article. Runs in background, survives navigation.
     */
    fun startSynthesis(articleId: String, text: String, voice: VoicePreset, articleTitle: String?) {
        // Cancel any existing job for this article
        cancelJob(articleId)

        // Create tracked job
        val trackedJob = TrackedJob(
            articleId = articleId,
            voiceId = voice.id,
            statusMessage = "Connecting..."
        )
        updateJob(articleId, trackedJob)

        // Persist pending state to DB
        scope.launch {
            articleRepository.updatePendingJob(articleId, "pending", "processing")
        }

        // Launch synthesis in background coroutine
        val job = scope.launch {
            try {
                val result = ttsCoordinator.synthesize(
                    text = text,
                    voice = voice,
                    onProgress = { progress ->
                        val currentJob = _jobs.value[articleId] ?: return@synthesize
                        val updatedJob = currentJob.copy(
                            progress = progress.overallProgress,
                            statusMessage = progress.statusMessage,
                            status = when {
                                progress.hasPreviewReady -> "partial_ready"
                                progress.overallProgress >= 1.0f -> "ready"
                                progress.overallProgress > 0 -> "processing"
                                else -> "queued"
                            },
                            previewUrl = progress.previewUrl ?: currentJob.previewUrl,
                            previewDurationSec = if (progress.previewDurationSec != null && progress.previewDurationSec > 0)
                                progress.previewDurationSec else currentJob.previewDurationSec
                        )
                        updateJob(articleId, updatedJob)
                    }
                )

                // Synthesis complete - update with result
                val audioPath = result.audioFile.absolutePath
                val durationMs = (result.duration * 1000).toLong()

                updateJob(articleId, _jobs.value[articleId]!!.copy(
                    status = "ready",
                    progress = 1.0f,
                    statusMessage = "Complete",
                    audioFilePath = audioPath,
                    durationMs = durationMs
                ))

                // Persist to DB
                articleRepository.updateSynthesisStatus(
                    id = articleId,
                    status = "completed",
                    audioUrl = audioPath,
                    duration = durationMs,
                    voiceId = voice.id
                )
                articleRepository.updatePendingJob(articleId, null, "completed")

                // Show notification
                val durationFormatted = formatDuration(durationMs)
                notificationService.showArticleTTSComplete(
                    articleId = articleId,
                    articleTitle = articleTitle ?: "Article",
                    durationFormatted = durationFormatted
                )

                Log.d(TAG, "Synthesis complete for $articleId: $audioPath ($durationMs ms)")

            } catch (e: CancellationException) {
                Log.d(TAG, "Synthesis cancelled for $articleId")
                removeJob(articleId)
                throw e
            } catch (e: Exception) {
                Log.e(TAG, "Synthesis failed for $articleId", e)
                val errorMessage = when {
                    e is TTSError.QuotaExceeded -> "quota_exceeded"
                    e.message?.contains("Network", ignoreCase = true) == true ->
                        "Network error. Please check your connection."
                    e.message?.contains("timeout", ignoreCase = true) == true ->
                        "Request timed out. The server might be busy."
                    else -> e.message ?: "Synthesis failed"
                }
                updateJob(articleId, (_jobs.value[articleId] ?: trackedJob).copy(
                    status = "failed",
                    statusMessage = errorMessage
                ))
                articleRepository.updatePendingJob(articleId, null, "failed")
            }
        }

        activeCoroutines[articleId] = job
    }

    fun cancelJob(articleId: String) {
        activeCoroutines[articleId]?.cancel()
        activeCoroutines.remove(articleId)
        removeJob(articleId)
    }

    private fun updateJob(articleId: String, job: TrackedJob) {
        _jobs.value = _jobs.value.toMutableMap().apply { put(articleId, job) }
    }

    private fun removeJob(articleId: String) {
        _jobs.value = _jobs.value.toMutableMap().apply { remove(articleId) }
    }

    private fun formatDuration(durationMs: Long): String {
        val totalSeconds = durationMs / 1000
        val minutes = totalSeconds / 60
        val seconds = totalSeconds % 60
        return if (minutes > 0) "${minutes}m ${seconds}s" else "${seconds}s"
    }
}
