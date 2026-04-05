package com.listenai.ui.playback

import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.listenai.R
import java.io.File
import com.listenai.data.models.Article
import com.listenai.data.models.Plan
import com.listenai.data.models.SourceType
import com.listenai.data.models.VoicePreset
import com.listenai.data.repository.ArticleRepository
import com.listenai.service.playback.AudioPlaybackService
import com.listenai.service.playback.AudioPlaybackStatus
import com.listenai.service.playback.PlayerMode
import com.listenai.service.tts.TTSCoordinator
import com.listenai.service.tts.TTSError
import com.listenai.service.review.AppReviewService
import com.listenai.service.notification.TTSNotificationService
import com.listenai.ui.theme.Blue
import com.listenai.ui.theme.Orange
import com.listenai.ui.theme.Green
import com.listenai.ui.theme.Yellow
import com.listenai.ui.voice.VoicePickerBottomSheet
import com.listenai.ui.voice.toVoicePreset
import com.listenai.ui.components.FormattedTextView
import com.listenai.service.voice.VoiceCloningService
import kotlinx.coroutines.launch
import org.koin.compose.koinInject

sealed class PlayerState {
    object Loading : PlayerState()
    data class Ready(val article: Article) : PlayerState()
    data class Synthesizing(val article: Article, val progress: Float) : PlayerState()
    data class Playing(val article: Article) : PlayerState()
    data class Error(val message: String, val article: Article? = null) : PlayerState()
    data class QuotaExceeded(val remaining: Int, val required: Int, val article: Article) : PlayerState()
    data class RateLimited(val retryAfterSeconds: Int, val article: Article) : PlayerState()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlayerScreen(
    articleId: String,
    onNavigateBack: () -> Unit,
    onUpgrade: () -> Unit = {},
    onNavigateToVoiceCloning: () -> Unit = {},
    articleRepository: ArticleRepository = koinInject(),
    playbackService: AudioPlaybackService = koinInject(),
    ttsCoordinator: TTSCoordinator = koinInject(),
    appReviewService: AppReviewService = koinInject(),
    ttsNotificationService: TTSNotificationService = koinInject(),
    voiceCloningService: VoiceCloningService = koinInject()
) {
    var playerState by remember { mutableStateOf<PlayerState>(PlayerState.Loading) }
    var synthesisProgress by remember { mutableFloatStateOf(0f) }
    var showVoicePicker by remember { mutableStateOf(false) }
    var showMoreOptions by remember { mutableStateOf(false) }
    var showSleepTimerPicker by remember { mutableStateOf(false) }
    var selectedVoice by remember { mutableStateOf<VoicePreset?>(null) }
    var availableVoices by remember { mutableStateOf<List<VoicePreset>>(emptyList()) }

    val playbackState by playbackService.playbackState.collectAsState()
    val scrollState = rememberScrollState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    // Load available voices
    LaunchedEffect(Unit) {
        availableVoices = ttsCoordinator.getAvailableVoices()
    }

    // Load article and set initial voice from article's selectedVoiceId
    LaunchedEffect(articleId) {
        playerState = PlayerState.Loading
        val article = articleRepository.getArticleById(articleId)
        if (article == null) {
            playerState = PlayerState.Error(context.getString(R.string.player_article_not_found))
        } else {
            playerState = PlayerState.Ready(article)
            // Set selectedVoice from article if it has one, otherwise use first available
            val voices = ttsCoordinator.getAvailableVoices()
            selectedVoice = article.selectedVoiceId?.let { voiceId ->
                // First check if it's a cloned voice (ID starts with "cloned_")
                if (voiceId.startsWith("cloned_")) {
                    // Extract the actual voice ID and look up the cloned voice
                    val actualVoiceId = voiceId.removePrefix("cloned_")
                    try {
                        val clonedVoices = voiceCloningService.listClonedVoices()
                        clonedVoices.find { it.id == actualVoiceId }?.toVoicePreset()
                    } catch (e: Exception) {
                        android.util.Log.e("PlayerScreen", "Failed to load cloned voice: ${e.message}")
                        null
                    }
                } else {
                    voices.find { it.id == voiceId }
                }
            } ?: voices.firstOrNull()
        }
    }

    // Get current article from state
    val currentArticle = when (val state = playerState) {
        is PlayerState.Ready -> state.article
        is PlayerState.Synthesizing -> state.article
        is PlayerState.Playing -> state.article
        is PlayerState.Error -> state.article
        is PlayerState.QuotaExceeded -> state.article
        is PlayerState.RateLimited -> state.article
        else -> null
    }

    // Track whether we've started preview playback (to avoid duplicates)
    var hasStartedPreviewPlayback by remember { mutableStateOf(false) }

    // Function to start synthesis and play
    fun startSynthesisAndPlay(article: Article) {
        android.util.Log.d("PlayerScreen", "startSynthesisAndPlay: articleId=${article.id}, hasAudio=${article.audioFileUrl != null}, textLength=${article.rawText.length}")

        // Reset preview tracking
        hasStartedPreviewPlayback = false

        // Check if audio already exists
        if (article.audioFileUrl != null) {
            android.util.Log.d("PlayerScreen", "Playing existing audio: ${article.audioFileUrl}")
            playbackService.play(article, article.audioFileUrl, PlayerMode.FULL, null)
            playerState = PlayerState.Playing(article)

            // Record TTS playback success for app review prompt
            appReviewService.recordTTSPlaybackSuccess()
            appReviewService.checkAndTriggerFeedbackPrompt()
            return
        }

        // Check if there's text to synthesize
        if (article.rawText.isBlank()) {
            android.util.Log.e("PlayerScreen", "No text to synthesize")
            playerState = PlayerState.Error(context.getString(R.string.player_no_text_content), article)
            return
        }

        // Start synthesis
        playerState = PlayerState.Synthesizing(article, 0f)

        scope.launch {
            try {
                // Use currently selected voice or fall back to first available
                val voice = selectedVoice ?: article.selectedVoiceId?.let { voiceId ->
                    availableVoices.find { it.id == voiceId }
                } ?: availableVoices.firstOrNull()

                if (voice == null) {
                    android.util.Log.e("PlayerScreen", "No voice available")
                    playerState = PlayerState.Error(context.getString(R.string.player_no_voice_available), article)
                    return@launch
                }

                android.util.Log.d("PlayerScreen", "Using voice: ${voice.name} (${voice.kokoroVoiceId ?: voice.providerVoiceId})")

                val result = ttsCoordinator.synthesize(
                    text = article.rawText,
                    voice = voice,
                    onProgress = { progress ->
                        // Update UI state (called from IO dispatcher, but Compose state is thread-safe)
                        synthesisProgress = progress.overallProgress
                        playerState = PlayerState.Synthesizing(article, progress.overallProgress)

                        // Handle preview audio - start playback immediately when preview is ready
                        if (progress.hasPreviewReady && !hasStartedPreviewPlayback) {
                            hasStartedPreviewPlayback = true
                            val previewUrl = progress.previewUrl!!
                            val previewDuration = progress.previewDurationSec

                            android.util.Log.d("PlayerScreen", "Preview ready! Starting preview playback: $previewUrl (${previewDuration}s)")

                            // Start preview playback on main thread (ExoPlayer requirement)
                            scope.launch(Dispatchers.Main) {
                                playbackService.play(article, previewUrl, PlayerMode.PREVIEW, previewDuration)
                                playerState = PlayerState.Playing(article)

                                // Record TTS playback success for app review prompt
                                appReviewService.recordTTSPlaybackSuccess()
                                appReviewService.checkAndTriggerFeedbackPrompt()
                            }
                        }
                    }
                )

                // Full audio synthesis complete
                val audioFile = result.audioFile
                val durationMs = (result.duration * 1000).toLong()

                android.util.Log.d("PlayerScreen", "Synthesis complete: file=${audioFile.absolutePath}, duration=$durationMs ms")

                // Update article with audio URL and voice ID
                articleRepository.updateSynthesisStatus(
                    id = articleId,
                    status = "completed",
                    audioUrl = audioFile.absolutePath,
                    duration = durationMs,
                    voiceId = voice.id
                )

                // Show notification that TTS is complete
                val durationFormatted = formatDuration(durationMs, context)
                ttsNotificationService.showArticleTTSComplete(
                    articleId = articleId,
                    articleTitle = article.title ?: context.getString(R.string.player_article_fallback),
                    durationFormatted = durationFormatted
                )

                // Start playback on main thread (ExoPlayer requirement)
                withContext(Dispatchers.Main) {
                    // If we were playing preview, seamlessly swap to full audio
                    if (hasStartedPreviewPlayback && playbackState.playerMode == PlayerMode.PREVIEW) {
                        android.util.Log.d("PlayerScreen", "Swapping from preview to full audio")
                        playbackService.swapToFullAudio(audioFile.absolutePath)
                    } else {
                        // Start full playback (wasn't playing preview)
                        android.util.Log.d("PlayerScreen", "Starting full audio playback")
                        playbackService.play(article, audioFile.absolutePath, PlayerMode.FULL, null)

                        // Record TTS playback success for app review prompt (only if not already triggered by preview)
                        appReviewService.recordTTSPlaybackSuccess()
                        appReviewService.checkAndTriggerFeedbackPrompt()
                    }
                    playerState = PlayerState.Playing(article)
                }

            } catch (e: Exception) {
                android.util.Log.e("PlayerScreen", "Synthesis failed", e)
                when (e) {
                    is TTSError.QuotaExceeded -> {
                        android.util.Log.d("PlayerScreen", "Quota exceeded: remaining=${e.remaining}, required=${e.required}")
                        playerState = PlayerState.QuotaExceeded(e.remaining, e.required, article)
                    }
                    is TTSError.RateLimited -> {
                        android.util.Log.d("PlayerScreen", "Rate limited: retryAfter=${e.retryAfterSeconds}")
                        playerState = PlayerState.RateLimited(e.retryAfterSeconds.toInt(), article)
                    }
                    else -> {
                        val errorMessage = when {
                            e.message?.contains("Network", ignoreCase = true) == true ->
                                context.getString(R.string.player_network_error)
                            e.message?.contains("timeout", ignoreCase = true) == true ->
                                context.getString(R.string.player_timeout_error)
                            e.message?.contains("rate limit", ignoreCase = true) == true ->
                                context.getString(R.string.player_rate_limit_error)
                            else -> e.message ?: context.getString(R.string.player_synthesis_failed)
                        }
                        playerState = PlayerState.Error(errorMessage, article)
                    }
                }
            }
        }
    }

    // Function to regenerate audio with new voice - defined here so it's accessible from error handling
    fun regenerateWithVoice(voice: VoicePreset, article: Article) {
        selectedVoice = voice
        showVoicePicker = false

        // Stop current playback
        playbackService.stop()

        // Reset preview tracking for regeneration
        hasStartedPreviewPlayback = false

        // Clear existing audio URL and update voice ID immediately
        scope.launch {
            // Update voiceId immediately so "Try Again" uses correct voice
            articleRepository.updateSynthesisStatus(
                id = article.id,
                status = "pending",
                audioUrl = null,
                duration = 0L,
                voiceId = voice.id
            )

            // Start fresh synthesis with new voice
            playerState = PlayerState.Synthesizing(article, 0f)

            try {
                android.util.Log.d("PlayerScreen", "Regenerating with voice: ${voice.name}")

                val result = ttsCoordinator.synthesize(
                    text = article.rawText,
                    voice = voice,
                    onProgress = { progress ->
                        // Update UI state (called from IO dispatcher, but Compose state is thread-safe)
                        synthesisProgress = progress.overallProgress
                        playerState = PlayerState.Synthesizing(article, progress.overallProgress)

                        // Handle preview audio - start playback immediately when preview is ready
                        if (progress.hasPreviewReady && !hasStartedPreviewPlayback) {
                            hasStartedPreviewPlayback = true
                            val previewUrl = progress.previewUrl!!
                            val previewDuration = progress.previewDurationSec

                            android.util.Log.d("PlayerScreen", "Preview ready during regeneration: $previewUrl (${previewDuration}s)")

                            // Start preview playback on main thread (ExoPlayer requirement)
                            scope.launch(Dispatchers.Main) {
                                playbackService.play(article, previewUrl, PlayerMode.PREVIEW, previewDuration)
                                playerState = PlayerState.Playing(article)
                            }
                        }
                    }
                )

                val audioFile = result.audioFile
                val durationMs = (result.duration * 1000).toLong()

                // Update article with new audio URL
                articleRepository.updateSynthesisStatus(
                    id = article.id,
                    status = "completed",
                    audioUrl = audioFile.absolutePath,
                    duration = durationMs,
                    voiceId = voice.id
                )

                // Show notification that TTS is complete
                val durationFormatted = formatDuration(durationMs, context)
                ttsNotificationService.showArticleTTSComplete(
                    articleId = article.id,
                    articleTitle = article.title ?: context.getString(R.string.player_article_fallback),
                    durationFormatted = durationFormatted
                )

                // Start playback on main thread (ExoPlayer requirement)
                withContext(Dispatchers.Main) {
                    // If we were playing preview, seamlessly swap to full audio
                    val currentPlaybackState = playbackService.playbackState.value
                    if (hasStartedPreviewPlayback && currentPlaybackState.playerMode == PlayerMode.PREVIEW) {
                        android.util.Log.d("PlayerScreen", "Swapping from preview to full audio (regeneration)")
                        playbackService.swapToFullAudio(audioFile.absolutePath)
                    } else {
                        // Start full playback
                        playbackService.play(article, audioFile.absolutePath, PlayerMode.FULL, null)
                    }
                    playerState = PlayerState.Playing(article)
                }

            } catch (e: Exception) {
                android.util.Log.e("PlayerScreen", "Regeneration failed", e)
                playerState = PlayerState.Error(e.message ?: context.getString(R.string.player_regeneration_failed), article)
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.player_back)
                        )
                    }
                },
                actions = {
                    // Voice picker
                    IconButton(onClick = { showVoicePicker = true }) {
                        Icon(Icons.Default.RecordVoiceOver, contentDescription = stringResource(R.string.player_change_voice))
                    }
                    // More options
                    IconButton(onClick = { showMoreOptions = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.player_more_options))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface
                )
            )
        },
        bottomBar = {
            currentArticle?.let { article ->
                PlayerBar(
                    isPlaying = playbackState.status == AudioPlaybackStatus.PLAYING,
                    isSynthesizing = playerState is PlayerState.Synthesizing,
                    synthesisProgress = synthesisProgress,
                    progress = playbackState.progress,
                    currentTime = playbackState.currentTime,
                    totalDuration = playbackState.duration,
                    speed = playbackState.speed,
                    selectedVoice = selectedVoice,
                    playerMode = playbackState.playerMode,
                    previewDuration = playbackState.previewDuration,
                    isAwaitingFullAudio = playbackState.isAwaitingFullAudio,
                    onPlayPause = {
                        when (playerState) {
                            is PlayerState.Ready -> {
                                startSynthesisAndPlay(article)
                            }
                            is PlayerState.Playing -> {
                                playbackService.togglePlayPause()
                            }
                            else -> { }
                        }
                    },
                    onSeek = { progress ->
                        val seekPosition = progress * playbackState.duration
                        playbackService.seekTo(seekPosition)
                    },
                    onSkipBackward = { playbackService.seekBackward(10.0) },
                    onSkipForward = { playbackService.seekForward(10.0) },
                    onSpeedChange = { newSpeed -> playbackService.setSpeed(newSpeed) },
                    onVoiceChange = { showVoicePicker = true }
                )
            }
        }
    ) { padding ->
        // Check if audio has been generated
        val hasGeneratedAudio = currentArticle?.audioFileUrl != null

        // Voice Picker Bottom Sheet
        if (showVoicePicker) {
            VoicePickerBottomSheet(
                voices = availableVoices,
                selectedVoice = selectedVoice,
                hasGeneratedAudio = hasGeneratedAudio,
                onVoiceSelected = { voice ->
                    selectedVoice = voice
                    showVoicePicker = false
                },
                onRegenerateWithVoice = { voice ->
                    currentArticle?.let { article ->
                        regenerateWithVoice(voice, article)
                    }
                },
                onNavigateToVoiceCloning = {
                    showVoicePicker = false
                    onNavigateToVoiceCloning()
                },
                onDismiss = { showVoicePicker = false }
            )
        }

        // More Options Bottom Sheet
        if (showMoreOptions && currentArticle != null) {
            MoreOptionsSheet(
                article = currentArticle,
                selectedVoice = selectedVoice,
                hasAudio = hasGeneratedAudio,
                sleepTimerRemaining = playbackState.sleepTimerRemaining,
                onAddToQueue = {
                    // TODO: Implement queue functionality
                    Toast.makeText(context, context.getString(R.string.player_added_to_queue), Toast.LENGTH_SHORT).show()
                    showMoreOptions = false
                },
                onMarkAsFinished = {
                    scope.launch {
                        articleRepository.updatePlaybackProgress(
                            id = currentArticle.id,
                            listenedDuration = (playbackState.duration * 1000).toLong(),
                            lastPosition = (playbackState.duration * 1000).toLong(),
                            isCompleted = true
                        )
                        Toast.makeText(context, context.getString(R.string.player_marked_finished), Toast.LENGTH_SHORT).show()
                    }
                    showMoreOptions = false
                },
                onToggleFavorite = {
                    scope.launch {
                        articleRepository.toggleFavorite(currentArticle)
                        // Refresh article state
                        val updatedArticle = articleRepository.getArticleById(currentArticle.id)
                        if (updatedArticle != null) {
                            playerState = when (playerState) {
                                is PlayerState.Ready -> PlayerState.Ready(updatedArticle)
                                is PlayerState.Playing -> PlayerState.Playing(updatedArticle)
                                is PlayerState.Synthesizing -> PlayerState.Synthesizing(updatedArticle, synthesisProgress)
                                else -> playerState
                            }
                        }
                        val message = if (currentArticle.isFavorite) context.getString(R.string.player_removed_from_favorites) else context.getString(R.string.player_added_to_favorites)
                        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
                    }
                    showMoreOptions = false
                },
                onSleepTimer = {
                    showSleepTimerPicker = true
                    showMoreOptions = false
                },
                onExportAudio = {
                    currentArticle.audioFileUrl?.let { audioPath ->
                        try {
                            val audioFile = File(audioPath)
                            if (audioFile.exists()) {
                                val uri = FileProvider.getUriForFile(
                                    context,
                                    "${context.packageName}.fileprovider",
                                    audioFile
                                )
                                val shareIntent = Intent(Intent.ACTION_SEND).apply {
                                    type = "audio/mpeg"
                                    putExtra(Intent.EXTRA_STREAM, uri)
                                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                }
                                context.startActivity(Intent.createChooser(shareIntent, context.getString(R.string.player_export_audio)))
                            } else {
                                Toast.makeText(context, context.getString(R.string.player_audio_not_found), Toast.LENGTH_SHORT).show()
                            }
                        } catch (e: Exception) {
                            Toast.makeText(context, context.getString(R.string.player_export_failed, e.message ?: ""), Toast.LENGTH_SHORT).show()
                        }
                    }
                    showMoreOptions = false
                },
                onDeleteArticle = {
                    scope.launch {
                        articleRepository.deleteArticleById(currentArticle.id)
                        playbackService.stop()
                        onNavigateBack()
                    }
                },
                onDismiss = { showMoreOptions = false }
            )
        }

        // Sleep Timer Picker
        if (showSleepTimerPicker) {
            SleepTimerPickerDialog(
                currentTimerRemaining = playbackState.sleepTimerRemaining,
                onTimerSet = { minutes ->
                    playbackService.setSleepTimer(minutes)
                    val message = if (minutes > 0) context.getString(R.string.player_sleep_timer_set, minutes) else context.getString(R.string.player_sleep_timer_cancelled)
                    Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
                    showSleepTimerPicker = false
                },
                onDismiss = { showSleepTimerPicker = false }
            )
        }

        when (val state = playerState) {
            is PlayerState.Loading -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = "⏳",
                            style = MaterialTheme.typography.displayLarge
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Text(
                            text = stringResource(R.string.player_loading_article),
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            is PlayerState.Error -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.padding(24.dp)
                    ) {
                        Icon(
                            Icons.Default.Error,
                            contentDescription = null,
                            modifier = Modifier.size(64.dp),
                            tint = MaterialTheme.colorScheme.error
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Text(
                            text = stringResource(R.string.player_something_went_wrong),
                            style = MaterialTheme.typography.headlineSmall
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = state.message,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(modifier = Modifier.height(24.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            OutlinedButton(onClick = onNavigateBack) {
                                Text(stringResource(R.string.player_go_back))
                            }
                            Button(
                                onClick = {
                                    // Retry - force regeneration with current voice
                                    if (state.article != null && selectedVoice != null) {
                                        // Use regenerateWithVoice to ensure fresh synthesis
                                        regenerateWithVoice(selectedVoice!!, state.article)
                                    } else if (state.article != null) {
                                        // Fallback to startSynthesisAndPlay, but clear audio first
                                        scope.launch {
                                            articleRepository.updateSynthesisStatus(
                                                id = state.article.id,
                                                status = "pending",
                                                audioUrl = null,
                                                duration = 0L,
                                                voiceId = selectedVoice?.id
                                            )
                                            // Reload article to get updated state
                                            val freshArticle = articleRepository.getArticleById(state.article.id)
                                            if (freshArticle != null) {
                                                startSynthesisAndPlay(freshArticle)
                                            }
                                        }
                                    } else {
                                        playerState = PlayerState.Loading
                                    }
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = Blue)
                            ) {
                                Text(stringResource(R.string.player_try_again))
                            }
                        }
                    }
                }
            }

            is PlayerState.QuotaExceeded -> {
                // Auto-retry if user becomes premium (e.g. just purchased)
                val revenueCatManager = remember { com.listenai.service.billing.RevenueCatManager.getInstance() }
                val isPremiumNow by revenueCatManager.isPremium.collectAsState()
                val hasTriggeredRetry = remember { mutableStateOf(false) }
                if (isPremiumNow && !hasTriggeredRetry.value) {
                    hasTriggeredRetry.value = true
                    LaunchedEffect(Unit) {
                        playerState = PlayerState.Synthesizing(state.article, 0f)
                        startSynthesisAndPlay(state.article)
                    }
                }

                QuotaExceededContent(
                    remaining = state.remaining,
                    required = state.required,
                    onUpgrade = onUpgrade,
                    onGoBack = onNavigateBack,
                    modifier = Modifier.padding(padding)
                )
            }

            is PlayerState.RateLimited -> {
                val revenueCatManager = remember { com.listenai.service.billing.RevenueCatManager.getInstance() }
                val isPremiumNow by revenueCatManager.isPremium.collectAsState()

                RateLimitedContent(
                    retryAfterSeconds = state.retryAfterSeconds,
                    isPremium = isPremiumNow,
                    onUpgrade = onUpgrade,
                    onRetry = {
                        scope.launch {
                            playerState = PlayerState.Synthesizing(state.article, 0f)
                            startSynthesisAndPlay(state.article)
                        }
                    },
                    onGoBack = onNavigateBack,
                    modifier = Modifier.padding(padding)
                )
            }

            is PlayerState.Ready, is PlayerState.Synthesizing, is PlayerState.Playing -> {
                val article = currentArticle!!

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                ) {
                    // Synthesis banner if synthesizing
                    if (state is PlayerState.Synthesizing) {
                        SynthesisBanner(progress = state.progress)
                    }

                    // Scrollable article content
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(scrollState)
                            .padding(horizontal = 16.dp)
                    ) {
                        Spacer(modifier = Modifier.height(16.dp))

                        // Article header
                        ArticleHeader(article = article)

                        Divider(
                            modifier = Modifier.padding(vertical = 16.dp),
                            color = MaterialTheme.colorScheme.outlineVariant
                        )

                        // Article body text with highlighting
                        // Calculate current highlight index based on playback progress
                        val paragraphs = remember(article.rawText) {
                            article.rawText.split("\n\n")
                                .map { it.trim() }
                                .filter { it.isNotEmpty() }
                        }

                        val isPlaying = playbackState.status == AudioPlaybackStatus.PLAYING ||
                                        playbackState.status == AudioPlaybackStatus.PAUSED
                        val currentHighlightIndex = if (isPlaying && playbackState.articleId == article.id) {
                            // In preview mode, always highlight first paragraph
                            if (playbackState.playerMode == PlayerMode.PREVIEW) {
                                0
                            } else {
                                calculateHighlightIndex(
                                    currentTime = playbackState.currentTime,
                                    totalDuration = playbackState.duration,
                                    paragraphs = paragraphs
                                )
                            }
                        } else {
                            null
                        }

                        ArticleContent(
                            text = article.rawText,
                            currentHighlightIndex = currentHighlightIndex,
                            scrollState = scrollState,
                            scope = scope
                        )

                        // Bottom padding for player bar
                        Spacer(modifier = Modifier.height(120.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun ArticleHeader(article: Article) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        // Title
        Text(
            text = article.displayTitle,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold
        )

        // Email-specific header
        if (article.sourceType == SourceType.EMAIL) {
            EmailMetadataHeader(article)
        } else {
            // Standard metadata row
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Source type badge
                SourceBadge(sourceType = article.sourceType)

                // Author
                Text(
                    text = stringResource(R.string.player_by_author, article.displayAuthor),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        // Stats row
        Row(
            horizontalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Word count
            Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    Icons.Default.TextFields,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = stringResource(R.string.player_words_count, article.wordCount),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Duration
            Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    Icons.Default.Schedule,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = article.estimatedDurationFormatted,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Site name if available (for non-email sources)
            if (article.sourceType != SourceType.EMAIL) {
                article.siteName?.let { siteName ->
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            Icons.Default.Language,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            text = siteName,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
            }
        }
    }
}

/**
 * Email-specific metadata display showing sender info in email format
 */
@Composable
private fun EmailMetadataHeader(article: Article) {
    val dateFormat = remember { java.text.SimpleDateFormat("MMM d, yyyy 'at' h:mm a", java.util.Locale.getDefault()) }

    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        // Source badge row
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            SourceBadge(sourceType = SourceType.EMAIL)

            // Email date if available
            article.emailDate?.let { date ->
                Text(
                    text = dateFormat.format(date),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        // From line - sender info
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                text = stringResource(R.string.player_from_label),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontWeight = FontWeight.Medium
            )

            // Sender name and email
            val unknownSender = stringResource(R.string.player_unknown_sender)
            val senderDisplay = buildString {
                append(article.author ?: unknownSender)
                article.senderEmail?.let { email ->
                    if (email != article.author) {
                        append(" <$email>")
                    }
                }
            }

            Text(
                text = senderDisplay,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
private fun SourceBadge(sourceType: SourceType) {
    val (icon, label) = when (sourceType) {
        SourceType.WEB -> Icons.Default.Link to stringResource(R.string.source_web)
        SourceType.PDF -> Icons.Default.Description to stringResource(R.string.source_pdf)
        SourceType.EPUB -> Icons.Default.Book to stringResource(R.string.source_epub)
        SourceType.CLIPBOARD -> Icons.Default.ContentPaste to stringResource(R.string.source_clipboard)
        SourceType.FILE -> Icons.Default.Folder to stringResource(R.string.source_file)
        SourceType.MANUAL -> Icons.Default.Edit to stringResource(R.string.source_text)
        SourceType.EMAIL -> Icons.Default.Email to stringResource(R.string.source_email)
    }

    Surface(
        shape = RoundedCornerShape(16.dp),
        color = Blue.copy(alpha = 0.1f)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                icon,
                contentDescription = null,
                modifier = Modifier.size(12.dp),
                tint = Blue
            )
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = Blue
            )
        }
    }
}

/**
 * Calculate which paragraph should be highlighted based on playback progress.
 * Uses character count weighting so longer paragraphs get proportionally more time.
 */
private fun calculateHighlightIndex(
    currentTime: Double,
    totalDuration: Double,
    paragraphs: List<String>
): Int? {
    if (totalDuration <= 0 || paragraphs.isEmpty()) return null

    val totalChars = paragraphs.sumOf { it.length }
    if (totalChars == 0) return null

    val progress = (currentTime / totalDuration).coerceIn(0.0, 1.0)
    val targetCharPosition = (progress * totalChars).toInt()

    var cumulativeChars = 0
    for ((index, paragraph) in paragraphs.withIndex()) {
        cumulativeChars += paragraph.length
        if (cumulativeChars >= targetCharPosition) {
            return index
        }
    }

    return paragraphs.lastIndex
}

@Composable
private fun ArticleContent(
    text: String,
    currentHighlightIndex: Int?,
    scrollState: ScrollState,
    scope: CoroutineScope
) {
    // Use FormattedTextView for markdown rendering with highlighting
    FormattedTextView(
        content = text,
        fontSize = 18.sp,
        lineSpacing = 8.dp,
        highlightIndex = currentHighlightIndex,
        highlightColor = Yellow,
        highlightWordOnly = false,
        modifier = Modifier.fillMaxWidth()
    )
}

@Composable
private fun SynthesisBanner(progress: Float) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        shape = RoundedCornerShape(12.dp),
        color = Blue.copy(alpha = 0.1f)
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Progress indicator
            Text(
                text = "🎙️",
                style = MaterialTheme.typography.titleMedium
            )

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.player_preparing_audio),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium
                )
                Text(
                    text = stringResource(R.string.player_percent_complete, (progress * 100).toInt()),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun PlayerBar(
    isPlaying: Boolean,
    isSynthesizing: Boolean,
    synthesisProgress: Float,
    progress: Float,
    currentTime: Double,
    totalDuration: Double,
    speed: Float,
    selectedVoice: VoicePreset?,
    playerMode: PlayerMode,
    previewDuration: Double?,
    isAwaitingFullAudio: Boolean,
    onPlayPause: () -> Unit,
    onSeek: (Float) -> Unit,
    onSkipBackward: () -> Unit,
    onSkipForward: () -> Unit,
    onSpeedChange: (Float) -> Unit,
    onVoiceChange: () -> Unit
) {
    // Don't key sliderPosition to progress - only update when not sliding
    var sliderPosition by remember { mutableFloatStateOf(progress) }
    var isSliding by remember { mutableStateOf(false) }

    // Update slider position from progress only when not sliding
    LaunchedEffect(progress, isSliding) {
        if (!isSliding) {
            sliderPosition = progress
        }
    }

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shadowElevation = 8.dp,
        color = MaterialTheme.colorScheme.surface
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
        ) {
            // Seek slider - show 0 during synthesis to keep it at beginning
            val displayProgress = if (isSynthesizing) 0f else sliderPosition
            Slider(
                value = displayProgress,
                onValueChange = { newValue ->
                    isSliding = true
                    sliderPosition = newValue
                },
                onValueChangeFinished = {
                    onSeek(sliderPosition)
                    isSliding = false
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !isSynthesizing,
                colors = SliderDefaults.colors(
                    thumbColor = Blue,
                    activeTrackColor = Blue,
                    inactiveTrackColor = MaterialTheme.colorScheme.surfaceVariant
                )
            )

            // Time labels with player mode badge
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = formatTime(currentTime),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )

                // Player mode badge (Preview / Full / Loading)
                if (playerMode.isActive || isAwaitingFullAudio) {
                    PlayerModeBadge(
                        mode = playerMode,
                        isAwaitingFullAudio = isAwaitingFullAudio
                    )
                }

                Text(
                    text = formatTime(totalDuration),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Controls
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Speed button with dropdown menu
                SpeedSelector(
                    currentSpeed = speed,
                    onSpeedChange = onSpeedChange
                )

                // Skip backward 10s
                IconButton(
                    onClick = onSkipBackward,
                    enabled = !isSynthesizing
                ) {
                    Icon(
                        Icons.Default.Replay10,
                        contentDescription = stringResource(R.string.player_skip_back_10),
                        modifier = Modifier.size(32.dp)
                    )
                }

                // Play/Pause button
                IconButton(
                    onClick = onPlayPause,
                    modifier = Modifier
                        .size(64.dp)
                        .clip(CircleShape)
                        .background(Color(0xFFFDD835)) // Yellow color like iOS
                ) {
                    if (isSynthesizing) {
                        Text(
                            text = "⏳",
                            style = MaterialTheme.typography.headlineSmall
                        )
                    } else {
                        Icon(
                            imageVector = if (isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                            contentDescription = if (isPlaying) stringResource(R.string.pause) else stringResource(R.string.play),
                            modifier = Modifier.size(32.dp),
                            tint = Color.Black
                        )
                    }
                }

                // Skip forward 10s
                IconButton(
                    onClick = onSkipForward,
                    enabled = !isSynthesizing
                ) {
                    Icon(
                        Icons.Default.Forward10,
                        contentDescription = stringResource(R.string.player_skip_forward_10),
                        modifier = Modifier.size(32.dp)
                    )
                }

                // Voice button with current voice indicator
                VoiceIndicatorButton(
                    voice = selectedVoice,
                    onClick = onVoiceChange
                )
            }

            Spacer(modifier = Modifier.height(8.dp))
        }
    }
}

private fun formatTime(seconds: Double): String {
    val totalSeconds = seconds.toInt()
    val minutes = totalSeconds / 60
    val secs = totalSeconds % 60
    return String.format("%d:%02d", minutes, secs)
}

/**
 * Format duration in milliseconds to a human-readable string (e.g., "5 min", "1 hr 23 min")
 */
private fun formatDuration(durationMs: Long, context: android.content.Context? = null): String {
    val totalSeconds = (durationMs / 1000).toInt()
    val hours = totalSeconds / 3600
    val minutes = (totalSeconds % 3600) / 60
    val seconds = totalSeconds % 60

    return if (context != null) {
        when {
            hours > 0 -> {
                if (minutes > 0) context.getString(R.string.duration_hr_min, hours, minutes) else context.getString(R.string.duration_hr, hours)
            }
            minutes > 0 -> {
                context.getString(R.string.duration_min, minutes)
            }
            else -> {
                context.getString(R.string.duration_sec, seconds)
            }
        }
    } else {
        when {
            hours > 0 -> {
                if (minutes > 0) "$hours hr $minutes min" else "$hours hr"
            }
            minutes > 0 -> {
                "$minutes min"
            }
            else -> {
                "$seconds sec"
            }
        }
    }
}

/**
 * Badge showing Preview vs Full audio mode, or loading state
 * Matches iOS playerModeBadge implementation
 */
@Composable
private fun PlayerModeBadge(
    mode: PlayerMode,
    isAwaitingFullAudio: Boolean
) {
    val loadingFullText = stringResource(R.string.player_mode_loading_full)
    val previewText = stringResource(R.string.player_mode_preview)
    val fullText = stringResource(R.string.player_mode_full)

    val (backgroundColor, textColor, text) = when {
        isAwaitingFullAudio -> Triple(
            Blue.copy(alpha = 0.15f),
            Blue,
            loadingFullText
        )
        mode == PlayerMode.PREVIEW -> Triple(
            Orange.copy(alpha = 0.15f),
            Orange,
            previewText
        )
        mode == PlayerMode.FULL -> Triple(
            Green.copy(alpha = 0.15f),
            Green,
            fullText
        )
        else -> return // Don't show badge for NONE mode
    }

    Surface(
        shape = RoundedCornerShape(4.dp),
        color = backgroundColor
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (isAwaitingFullAudio) {
                // Show loading indicator
                CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    strokeWidth = 2.dp,
                    color = textColor
                )
            }
            Text(
                text = text,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                color = textColor
            )
        }
    }
}

/**
 * Speed selector with dropdown menu
 */
@Composable
private fun SpeedSelector(
    currentSpeed: Float,
    onSpeedChange: (Float) -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    val speeds = listOf(0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 1.75f, 2.0f)

    Box {
        TextButton(onClick = { expanded = true }) {
            Text(
                text = "${currentSpeed}x",
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Medium
            )
            Icon(
                Icons.Default.ArrowDropDown,
                contentDescription = stringResource(R.string.player_select_speed),
                modifier = Modifier.size(20.dp)
            )
        }

        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false }
        ) {
            speeds.forEach { speed ->
                DropdownMenuItem(
                    text = {
                        Row(
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(
                                text = "${speed}x",
                                fontWeight = if (speed == currentSpeed) FontWeight.Bold else FontWeight.Normal
                            )
                            if (speed == currentSpeed) {
                                Icon(
                                    Icons.Default.Check,
                                    contentDescription = stringResource(R.string.selected_check),
                                    tint = Blue,
                                    modifier = Modifier.size(20.dp)
                                )
                            }
                        }
                    },
                    onClick = {
                        onSpeedChange(speed)
                        expanded = false
                    }
                )
            }
        }
    }
}

/**
 * Voice indicator button showing the current voice with avatar emoji
 */
@Composable
private fun VoiceIndicatorButton(
    voice: VoicePreset?,
    onClick: () -> Unit
) {
    // Check if this is a cloned voice (ID starts with "cloned_" or uses chatterbox model)
    val isClonedVoice = voice?.id?.startsWith("cloned_") == true || voice?.providerModelId == "chatterbox"

    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (isClonedVoice) {
                // Show "C" badge for cloned voices
                Box(
                    modifier = Modifier
                        .size(20.dp)
                        .clip(CircleShape)
                        .background(Yellow),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "C",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        color = Color.Black
                    )
                }
                // Just show "Cloned" text
                Text(
                    text = stringResource(R.string.player_cloned_voice),
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            } else {
                // Avatar emoji or fallback icon for built-in voices
                if (voice?.avatarEmoji != null) {
                    Text(
                        text = voice.avatarEmoji,
                        style = MaterialTheme.typography.bodyMedium
                    )
                } else {
                    Icon(
                        Icons.Default.RecordVoiceOver,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                // Voice name
                Text(
                    text = voice?.name ?: stringResource(R.string.player_voice_fallback),
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }

            // Dropdown arrow
            Icon(
                Icons.Default.ArrowDropDown,
                contentDescription = stringResource(R.string.player_change_voice_button),
                modifier = Modifier.size(16.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun QuotaExceededContent(
    remaining: Int,
    required: Int,
    onUpgrade: () -> Unit,
    onGoBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(24.dp)
        ) {
            // Warning icon
            Surface(
                shape = CircleShape,
                color = Color(0xFFFFF3E0) // Orange light background
            ) {
                Icon(
                    Icons.Default.Warning,
                    contentDescription = null,
                    modifier = Modifier
                        .padding(16.dp)
                        .size(48.dp),
                    tint = Color(0xFFF57C00) // Orange
                )
            }

            Spacer(modifier = Modifier.height(24.dp))

            Text(
                text = stringResource(R.string.quota_exceeded_title),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold
            )

            Spacer(modifier = Modifier.height(12.dp))

            Text(
                text = stringResource(R.string.quota_exceeded_message, remaining, required),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center
            )

            Spacer(modifier = Modifier.height(32.dp))

            // Plan comparison card
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
            ) {
                Column(
                    modifier = Modifier.padding(20.dp)
                ) {
                    Text(
                        text = stringResource(R.string.quota_upgrade_to_pro),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = Color(0xFF8B5CF6) // Purple
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    // Benefits list
                    QuotaBenefit(text = stringResource(R.string.quota_benefit_chars_day))
                    QuotaBenefit(text = stringResource(R.string.quota_benefit_chars_month))
                    QuotaBenefit(text = stringResource(R.string.quota_benefit_premium_voices))
                    QuotaBenefit(text = stringResource(R.string.quota_benefit_priority))
                }
            }

            Spacer(modifier = Modifier.height(24.dp))

            // Action buttons
            Button(
                onClick = onUpgrade,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF8B5CF6) // Purple
                ),
                shape = RoundedCornerShape(12.dp)
            ) {
                Icon(
                    Icons.Default.Star,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = stringResource(R.string.quota_upgrade_to_pro),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
            }

            Spacer(modifier = Modifier.height(12.dp))

            TextButton(onClick = onGoBack) {
                Text(
                    text = stringResource(R.string.quota_maybe_later),
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Quota reset info
            Text(
                text = stringResource(R.string.quota_reset_info),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun RateLimitedContent(
    retryAfterSeconds: Int,
    isPremium: Boolean = false,
    onUpgrade: () -> Unit,
    onRetry: () -> Unit,
    onGoBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    // Countdown timer
    var secondsLeft by remember { mutableStateOf(retryAfterSeconds) }
    LaunchedEffect(retryAfterSeconds) {
        while (secondsLeft > 0) {
            delay(1000L)
            secondsLeft--
        }
    }

    // Auto-retry when countdown finishes for premium users
    LaunchedEffect(secondsLeft, isPremium) {
        if (secondsLeft == 0 && isPremium) {
            onRetry()
        }
    }

    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(24.dp)
        ) {
            // Timer icon
            Surface(
                shape = CircleShape,
                color = if (isPremium) Color(0xFFE8F5E9) else Color(0xFFEDE9FE)
            ) {
                Icon(
                    if (isPremium) Icons.Default.HourglassBottom else Icons.Default.Timer,
                    contentDescription = null,
                    modifier = Modifier
                        .padding(16.dp)
                        .size(48.dp),
                    tint = if (isPremium) Color(0xFF4CAF50) else Color(0xFF8B5CF6)
                )
            }

            Spacer(modifier = Modifier.height(24.dp))

            Text(
                text = if (isPremium) "Hang tight!" else "You're on fire!",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold
            )

            Spacer(modifier = Modifier.height(12.dp))

            Text(
                text = if (isPremium)
                    "The server is briefly busy. Retrying automatically..."
                else
                    "Free accounts are limited to 10 requests per minute. Upgrade for unlimited listening with no wait times.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center
            )

            if (!isPremium) {
                Spacer(modifier = Modifier.height(32.dp))

                // Pro benefits card
                Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                ) {
                    Column(
                        modifier = Modifier.padding(20.dp)
                    ) {
                        Text(
                            text = "Upgrade to Pro",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = Color(0xFF8B5CF6)
                        )
                        Spacer(modifier = Modifier.height(12.dp))
                        QuotaBenefit(text = "Unlimited requests — no rate limits")
                        QuotaBenefit(text = "30 articles per day")
                        QuotaBenefit(text = "Premium HD voices")
                        QuotaBenefit(text = "Priority synthesis queue")
                    }
                }

                Spacer(modifier = Modifier.height(24.dp))

                // Upgrade button
                Button(
                    onClick = onUpgrade,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Color(0xFF8B5CF6)
                    ),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Icon(
                        Icons.Default.Star,
                        contentDescription = null,
                        modifier = Modifier.size(20.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Upgrade to Pro",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Retry button with countdown
            if (secondsLeft > 0) {
                if (isPremium) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = Color(0xFF4CAF50),
                        strokeWidth = 2.dp
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Retrying in ${secondsLeft}s...",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                } else {
                    TextButton(onClick = {}, enabled = false) {
                        Text(
                            text = "Try again in ${secondsLeft}s",
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            } else {
                TextButton(onClick = onRetry) {
                    Text(
                        text = "Try Again",
                        color = Blue
                    )
                }
            }
        }
    }
}

@Composable
private fun QuotaBenefit(text: String) {
    Row(
        modifier = Modifier.padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            Icons.Default.Check,
            contentDescription = null,
            modifier = Modifier.size(18.dp),
            tint = Color(0xFF10B981) // Green
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface
        )
    }
}

/**
 * More Options Bottom Sheet - matches iOS MoreOptionsSheet
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MoreOptionsSheet(
    article: Article,
    selectedVoice: VoicePreset?,
    hasAudio: Boolean,
    sleepTimerRemaining: Int?,
    onAddToQueue: () -> Unit,
    onMarkAsFinished: () -> Unit,
    onToggleFavorite: () -> Unit,
    onSleepTimer: () -> Unit,
    onExportAudio: () -> Unit,
    onDeleteArticle: () -> Unit,
    onDismiss: () -> Unit
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 32.dp)
        ) {
            // Article header
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Source icon
                Box(
                    modifier = Modifier
                        .size(50.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = when (article.sourceType) {
                            SourceType.WEB -> Icons.Default.Language
                            SourceType.PDF -> Icons.Default.PictureAsPdf
                            SourceType.EMAIL -> Icons.Default.Email
                            SourceType.CLIPBOARD, SourceType.MANUAL -> Icons.Default.TextSnippet
                            else -> Icons.Default.Article
                        },
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = article.title ?: stringResource(R.string.player_untitled),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = article.sourceType.name.uppercase(),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            HorizontalDivider()

            // Download Audio / Voice info
            if (hasAudio) {
                MoreOptionsRow(
                    icon = Icons.Default.Download,
                    title = stringResource(R.string.more_options_download_audio),
                    subtitle = stringResource(R.string.more_options_download_subtitle),
                    trailing = selectedVoice?.name
                ) { }
                HorizontalDivider(modifier = Modifier.padding(start = 60.dp))
            }

            // Add to Queue
            MoreOptionsRow(
                icon = Icons.Default.PlaylistAdd,
                title = stringResource(R.string.more_options_add_to_queue)
            ) { onAddToQueue() }

            // Mark as Finished
            MoreOptionsRow(
                icon = Icons.Default.CheckCircleOutline,
                title = stringResource(R.string.more_options_mark_finished)
            ) { onMarkAsFinished() }

            // Add to/Remove from Favorites
            MoreOptionsRow(
                icon = if (article.isFavorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                title = if (article.isFavorite) stringResource(R.string.remove_from_favorites) else stringResource(R.string.add_to_favorites)
            ) { onToggleFavorite() }

            HorizontalDivider(modifier = Modifier.padding(start = 60.dp))

            // Sleep Timer
            MoreOptionsRow(
                icon = Icons.Default.Bedtime,
                title = stringResource(R.string.more_options_sleep_timer),
                trailing = sleepTimerRemaining?.let { formatSleepTimer(it) }
            ) { onSleepTimer() }

            // Export Audio
            if (hasAudio) {
                MoreOptionsRow(
                    icon = Icons.Default.Share,
                    title = stringResource(R.string.more_options_export_audio),
                    subtitle = stringResource(R.string.more_options_export_subtitle)
                ) { onExportAudio() }
            }

            HorizontalDivider(modifier = Modifier.padding(start = 60.dp))

            // Delete File
            MoreOptionsRow(
                icon = Icons.Default.Delete,
                title = stringResource(R.string.more_options_delete_article),
                isDestructive = true
            ) { onDeleteArticle() }
        }
    }
}

@Composable
private fun MoreOptionsRow(
    icon: ImageVector,
    title: String,
    subtitle: String? = null,
    trailing: String? = null,
    isDestructive: Boolean = false,
    onClick: () -> Unit
) {
    Surface(
        onClick = onClick,
        color = Color.Transparent
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                modifier = Modifier.size(24.dp),
                tint = if (isDestructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
            )

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (isDestructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
                )
                if (subtitle != null) {
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            if (trailing != null) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        Icons.Default.GraphicEq,
                        contentDescription = null,
                        modifier = Modifier.size(14.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        text = trailing,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

/**
 * Sleep Timer Picker Dialog
 */
@Composable
private fun SleepTimerPickerDialog(
    currentTimerRemaining: Int?,
    onTimerSet: (Int) -> Unit,
    onDismiss: () -> Unit
) {
    val timerOptions = listOf(
        0 to R.string.sleep_timer_off,
        5 to R.string.sleep_timer_5_min,
        10 to R.string.sleep_timer_10_min,
        15 to R.string.sleep_timer_15_min,
        30 to R.string.sleep_timer_30_min,
        45 to R.string.sleep_timer_45_min,
        60 to R.string.sleep_timer_1_hour,
        90 to R.string.sleep_timer_1_5_hours,
        120 to R.string.sleep_timer_2_hours
    )

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = stringResource(R.string.sleep_timer_picker_title),
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column {
                if (currentTimerRemaining != null && currentTimerRemaining > 0) {
                    Surface(
                        color = Blue.copy(alpha = 0.1f),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 16.dp)
                    ) {
                        Row(
                            modifier = Modifier.padding(12.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                Icons.Default.Timer,
                                contentDescription = null,
                                tint = Blue,
                                modifier = Modifier.size(20.dp)
                            )
                            Text(
                                text = stringResource(R.string.more_options_timer_active, formatSleepTimer(currentTimerRemaining)),
                                style = MaterialTheme.typography.bodyMedium,
                                color = Blue
                            )
                        }
                    }
                }

                timerOptions.forEach { (minutes, labelRes) ->
                    Surface(
                        onClick = { onTimerSet(minutes) },
                        color = Color.Transparent,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 12.dp, horizontal = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = stringResource(labelRes),
                                style = MaterialTheme.typography.bodyLarge
                            )
                            if (currentTimerRemaining != null && currentTimerRemaining > 0 && minutes == 0) {
                                // Show checkmark for "Off" when timer is active (to cancel)
                            } else if (currentTimerRemaining == null && minutes == 0) {
                                Icon(
                                    Icons.Default.Check,
                                    contentDescription = stringResource(R.string.more_options_current),
                                    tint = Blue,
                                    modifier = Modifier.size(20.dp)
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.cancel))
            }
        }
    )
}

private fun formatSleepTimer(seconds: Int): String {
    val minutes = seconds / 60
    val remainingSeconds = seconds % 60
    return when {
        minutes >= 60 -> {
            val hours = minutes / 60
            val mins = minutes % 60
            if (mins > 0) "${hours}h ${mins}m" else "${hours}h"
        }
        minutes > 0 -> "${minutes}m ${remainingSeconds}s"
        else -> "${remainingSeconds}s"
    }
}
