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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
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
import com.listenai.ui.theme.Blue
import com.listenai.ui.theme.Orange
import com.listenai.ui.theme.Green
import com.listenai.ui.theme.Yellow
import com.listenai.ui.voice.VoicePickerBottomSheet
import kotlinx.coroutines.launch
import org.koin.compose.koinInject

sealed class PlayerState {
    object Loading : PlayerState()
    data class Ready(val article: Article) : PlayerState()
    data class Synthesizing(val article: Article, val progress: Float) : PlayerState()
    data class Playing(val article: Article) : PlayerState()
    data class Error(val message: String, val article: Article? = null) : PlayerState()
    data class QuotaExceeded(val remaining: Int, val required: Int, val article: Article) : PlayerState()
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
    ttsCoordinator: TTSCoordinator = koinInject()
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
            playerState = PlayerState.Error("Article not found")
        } else {
            playerState = PlayerState.Ready(article)
            // Set selectedVoice from article if it has one, otherwise use first available
            val voices = ttsCoordinator.getAvailableVoices()
            selectedVoice = article.selectedVoiceId?.let { voiceId ->
                voices.find { it.id == voiceId }
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
            return
        }

        // Check if there's text to synthesize
        if (article.rawText.isBlank()) {
            android.util.Log.e("PlayerScreen", "No text to synthesize")
            playerState = PlayerState.Error("No text content to synthesize.", article)
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
                    playerState = PlayerState.Error("No voice available. Please check your TTS service connection.", article)
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
                    else -> {
                        val errorMessage = when {
                            e.message?.contains("Network", ignoreCase = true) == true ->
                                "Network error. Please check your internet connection."
                            e.message?.contains("timeout", ignoreCase = true) == true ->
                                "Request timed out. The server might be busy."
                            e.message?.contains("rate limit", ignoreCase = true) == true ->
                                "Server is busy. Please try again in a moment."
                            else -> e.message ?: "Synthesis failed"
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
                playerState = PlayerState.Error(e.message ?: "Regeneration failed", article)
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
                            contentDescription = "Back"
                        )
                    }
                },
                actions = {
                    // Voice picker
                    IconButton(onClick = { showVoicePicker = true }) {
                        Icon(Icons.Default.RecordVoiceOver, contentDescription = "Change Voice")
                    }
                    // More options
                    IconButton(onClick = { showMoreOptions = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "More")
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
                    Toast.makeText(context, "Added to queue", Toast.LENGTH_SHORT).show()
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
                        Toast.makeText(context, "Marked as finished", Toast.LENGTH_SHORT).show()
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
                        val message = if (currentArticle.isFavorite) "Removed from favorites" else "Added to favorites"
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
                                context.startActivity(Intent.createChooser(shareIntent, "Export Audio"))
                            } else {
                                Toast.makeText(context, "Audio file not found", Toast.LENGTH_SHORT).show()
                            }
                        } catch (e: Exception) {
                            Toast.makeText(context, "Failed to export: ${e.message}", Toast.LENGTH_SHORT).show()
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
                    val message = if (minutes > 0) "Sleep timer set for $minutes minutes" else "Sleep timer cancelled"
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
                            text = "Loading article...",
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
                            text = "Something went wrong",
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
                                Text("Go Back")
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
                                Text("Try Again")
                            }
                        }
                    }
                }
            }

            is PlayerState.QuotaExceeded -> {
                QuotaExceededContent(
                    remaining = state.remaining,
                    required = state.required,
                    onUpgrade = onUpgrade,
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
                    text = "by ${article.displayAuthor}",
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
                    text = "${article.wordCount} words",
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
                text = "From:",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontWeight = FontWeight.Medium
            )

            // Sender name and email
            val senderDisplay = buildString {
                append(article.author ?: "Unknown")
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
        SourceType.WEB -> Icons.Default.Link to "Web"
        SourceType.PDF -> Icons.Default.Description to "PDF"
        SourceType.CLIPBOARD -> Icons.Default.ContentPaste to "Clipboard"
        SourceType.FILE -> Icons.Default.Folder to "File"
        SourceType.MANUAL -> Icons.Default.Edit to "Text"
        SourceType.EMAIL -> Icons.Default.Email to "Email"
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
    // Split into paragraphs
    val paragraphs = remember(text) {
        text.split("\n\n")
            .map { it.trim() }
            .filter { it.isNotEmpty() }
    }

    // Track paragraph positions for auto-scroll
    val paragraphOffsets = remember { mutableStateMapOf<Int, Int>() }

    // Auto-scroll to highlighted paragraph
    LaunchedEffect(currentHighlightIndex) {
        currentHighlightIndex?.let { index ->
            paragraphOffsets[index]?.let { offset ->
                // Scroll with some padding above the paragraph
                val scrollTarget = (offset - 100).coerceAtLeast(0)
                scope.launch {
                    scrollState.animateScrollTo(scrollTarget)
                }
            }
        }
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        paragraphs.forEachIndexed { index, paragraph ->
            val isHighlighted = currentHighlightIndex == index

            HighlightedParagraph(
                text = paragraph,
                isHighlighted = isHighlighted,
                modifier = Modifier.onGloballyPositioned { coordinates ->
                    paragraphOffsets[index] = coordinates.positionInParent().y.toInt()
                }
            )
        }
    }
}

/**
 * A paragraph that can be highlighted during audio playback.
 * Uses yellow background highlighting matching the iOS design.
 */
@Composable
private fun HighlightedParagraph(
    text: String,
    isHighlighted: Boolean,
    modifier: Modifier = Modifier
) {
    val backgroundColor = if (isHighlighted) {
        Yellow.copy(alpha = 0.3f)
    } else {
        Color.Transparent
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(4.dp))
            .background(backgroundColor)
            .then(
                if (isHighlighted) {
                    Modifier.padding(8.dp)
                } else {
                    Modifier
                }
            )
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyLarge.copy(
                lineHeight = 28.sp
            ),
            color = MaterialTheme.colorScheme.onSurface
        )
    }
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
                    text = "Preparing audio...",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium
                )
                Text(
                    text = "${(progress * 100).toInt()}% complete",
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
                        contentDescription = "Skip back 10 seconds",
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
                            contentDescription = if (isPlaying) "Pause" else "Play",
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
                        contentDescription = "Skip forward 10 seconds",
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
 * Badge showing Preview vs Full audio mode, or loading state
 * Matches iOS playerModeBadge implementation
 */
@Composable
private fun PlayerModeBadge(
    mode: PlayerMode,
    isAwaitingFullAudio: Boolean
) {
    val (backgroundColor, textColor, text) = when {
        isAwaitingFullAudio -> Triple(
            Blue.copy(alpha = 0.15f),
            Blue,
            "Loading Full..."
        )
        mode == PlayerMode.PREVIEW -> Triple(
            Orange.copy(alpha = 0.15f),
            Orange,
            "Preview"
        )
        mode == PlayerMode.FULL -> Triple(
            Green.copy(alpha = 0.15f),
            Green,
            "Full"
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
                contentDescription = "Select speed",
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
                                    contentDescription = "Selected",
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
            // Avatar emoji or fallback icon
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
                text = voice?.name ?: "Voice",
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )

            // Dropdown arrow
            Icon(
                Icons.Default.ArrowDropDown,
                contentDescription = "Change voice",
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
                text = "Daily Quota Exceeded",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold
            )

            Spacer(modifier = Modifier.height(12.dp))

            Text(
                text = "You have $remaining characters remaining today,\nbut this article requires $required characters.",
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
                        text = "Upgrade to Pro",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = Color(0xFF8B5CF6) // Purple
                    )
                    Spacer(modifier = Modifier.height(12.dp))

                    // Benefits list
                    QuotaBenefit(text = "100K characters per day (25x more)")
                    QuotaBenefit(text = "1M characters per month")
                    QuotaBenefit(text = "Premium AI voices")
                    QuotaBenefit(text = "Priority synthesis queue")
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
                    text = "Upgrade to Pro",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
            }

            Spacer(modifier = Modifier.height(12.dp))

            TextButton(onClick = onGoBack) {
                Text(
                    text = "Maybe Later",
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Quota reset info
            Text(
                text = "Your daily quota resets at midnight",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
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
                        text = article.title ?: "Untitled",
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
                    title = "Download Audio",
                    subtitle = "Allows you to listen offline within the app.",
                    trailing = selectedVoice?.name
                ) { }
                HorizontalDivider(modifier = Modifier.padding(start = 60.dp))
            }

            // Add to Queue
            MoreOptionsRow(
                icon = Icons.Default.PlaylistAdd,
                title = "Add to Queue"
            ) { onAddToQueue() }

            // Mark as Finished
            MoreOptionsRow(
                icon = Icons.Default.CheckCircleOutline,
                title = "Mark as Finished"
            ) { onMarkAsFinished() }

            // Add to/Remove from Favorites
            MoreOptionsRow(
                icon = if (article.isFavorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                title = if (article.isFavorite) "Remove from Favorites" else "Add to Favorites"
            ) { onToggleFavorite() }

            HorizontalDivider(modifier = Modifier.padding(start = 60.dp))

            // Sleep Timer
            MoreOptionsRow(
                icon = Icons.Default.Bedtime,
                title = "Sleep Timer",
                trailing = sleepTimerRemaining?.let { formatSleepTimer(it) }
            ) { onSleepTimer() }

            // Export Audio
            if (hasAudio) {
                MoreOptionsRow(
                    icon = Icons.Default.Share,
                    title = "Export Audio",
                    subtitle = "Save audio to device or share it directly."
                ) { onExportAudio() }
            }

            HorizontalDivider(modifier = Modifier.padding(start = 60.dp))

            // Delete File
            MoreOptionsRow(
                icon = Icons.Default.Delete,
                title = "Delete Article",
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
        0 to "Off",
        5 to "5 minutes",
        10 to "10 minutes",
        15 to "15 minutes",
        30 to "30 minutes",
        45 to "45 minutes",
        60 to "1 hour",
        90 to "1.5 hours",
        120 to "2 hours"
    )

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = "Sleep Timer",
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
                                text = "Timer active: ${formatSleepTimer(currentTimerRemaining)}",
                                style = MaterialTheme.typography.bodyMedium,
                                color = Blue
                            )
                        }
                    }
                }

                timerOptions.forEach { (minutes, label) ->
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
                                text = label,
                                style = MaterialTheme.typography.bodyLarge
                            )
                            if (currentTimerRemaining != null && currentTimerRemaining > 0 && minutes == 0) {
                                // Show checkmark for "Off" when timer is active (to cancel)
                            } else if (currentTimerRemaining == null && minutes == 0) {
                                Icon(
                                    Icons.Default.Check,
                                    contentDescription = "Current",
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
                Text("Cancel")
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
