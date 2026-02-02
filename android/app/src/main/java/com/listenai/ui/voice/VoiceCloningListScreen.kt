package com.listenai.ui.voice

import android.media.MediaPlayer
import android.widget.Toast
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.listenai.service.tts.TTSCoordinator
import com.listenai.service.tts.SelfHostedTTSService
import com.listenai.service.tts.SynthesisOptions
import com.listenai.service.voice.VoiceCloningService
import com.listenai.service.notification.TTSNotificationService
import com.listenai.ui.theme.Blue
import com.listenai.ui.theme.Green
import com.listenai.ui.theme.Purple
import com.listenai.ui.theme.Red
import com.listenai.ui.theme.Yellow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.koin.compose.koinInject
import java.io.File

/**
 * Main voice cloning screen showing list of cloned voices.
 * Matches iOS VoiceCloningView design with empty state, voice list, and clone button.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceCloningListScreen(
    onNavigateBack: () -> Unit,
    onNavigateToCloneFlow: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val voiceCloningService: VoiceCloningService = koinInject()
    val ttsCoordinator: TTSCoordinator = koinInject()
    val ttsNotificationService: TTSNotificationService = koinInject()
    val selfHostedTTSService: SelfHostedTTSService = koinInject()

    // Sample text for voice preview (same as iOS)
    val sampleText = "Hello, this is a preview of your cloned voice. I can read your articles with this unique sound."

    // State
    var clonedVoices by remember { mutableStateOf<List<VoiceCloningService.ClonedVoice>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var isEditing by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    // Audio playback state
    var mediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }
    var playingVoiceId by remember { mutableStateOf<String?>(null) }
    var isPreviewLoading by remember { mutableStateOf(false) }
    var previewProgress by remember { mutableFloatStateOf(0f) }
    var previewStatusMessage by remember { mutableStateOf("") }
    var showNotifyWhenReady by remember { mutableStateOf(false) }
    var notifyWhenReadyVoiceId by remember { mutableStateOf<String?>(null) }

    // Preview cache directory
    val previewCacheDir = remember { File(context.cacheDir, "cloned_voice_previews").apply { mkdirs() } }

    // Delete confirmation
    var voiceToDelete by remember { mutableStateOf<VoiceCloningService.ClonedVoice?>(null) }
    var isDeleting by remember { mutableStateOf(false) }

    // Rename dialog
    var voiceToRename by remember { mutableStateOf<VoiceCloningService.ClonedVoice?>(null) }
    var newVoiceName by remember { mutableStateOf("") }
    var isRenaming by remember { mutableStateOf(false) }

    // Cleanup on dispose
    DisposableEffect(Unit) {
        onDispose {
            mediaPlayer?.release()
            mediaPlayer = null
        }
    }

    // Load voices on first composition
    LaunchedEffect(Unit) {
        try {
            clonedVoices = voiceCloningService.listClonedVoices(forceRefresh = true)
        } catch (e: Exception) {
            if (e !is VoiceCloningService.VoiceCloningError.NotConfigured) {
                errorMessage = e.message
            }
        } finally {
            isLoading = false
        }
    }

    // Check for and resume any active cloned voice synthesis jobs
    LaunchedEffect(clonedVoices) {
        // Check each voice for an active job
        for (voice in clonedVoices) {
            val activeJob = selfHostedTTSService.getActiveClonedJob(voice.id)
            if (activeJob != null) {
                android.util.Log.d("VoiceCloningList", "Found active job for voice ${voice.id}, resuming tracking")

                // Restore UI state
                playingVoiceId = voice.id
                isPreviewLoading = true
                previewProgress = activeJob.lastProgress
                previewStatusMessage = activeJob.lastStatusMessage

                // Resume tracking the job in a coroutine
                scope.launch {
                    try {
                        val result = selfHostedTTSService.resumeClonedJobTracking(voice.id) { progress ->
                            previewProgress = progress.overallProgress
                            previewStatusMessage = progress.statusMessage ?: "Synthesizing..."
                        }

                        if (result != null) {
                            // Job completed successfully - cache with correct extension and play
                            val wavCacheFile = File(previewCacheDir, "preview_${voice.id}.wav")
                            result.audioFile.copyTo(wavCacheFile, overwrite = true)

                            // Reset loading state before playing
                            isPreviewLoading = false
                            previewProgress = 0f
                            previewStatusMessage = ""

                            // Play the audio from the original file (which is .wav)
                            mediaPlayer = MediaPlayer().apply {
                                setDataSource(result.audioFile.absolutePath)
                                setOnPreparedListener { start() }
                                setOnCompletionListener {
                                    playingVoiceId = null
                                    release()
                                    mediaPlayer = null
                                }
                                setOnErrorListener { _, _, _ ->
                                    playingVoiceId = null
                                    Toast.makeText(context, "Failed to play preview", Toast.LENGTH_SHORT).show()
                                    true
                                }
                                prepareAsync()
                            }
                        } else {
                            // No result means job was not found or cancelled
                            isPreviewLoading = false
                            playingVoiceId = null
                            previewProgress = 0f
                            previewStatusMessage = ""
                        }
                    } catch (e: Exception) {
                        android.util.Log.e("VoiceCloningList", "Failed to resume job tracking", e)
                        isPreviewLoading = false
                        playingVoiceId = null
                        previewProgress = 0f
                        previewStatusMessage = ""
                        Toast.makeText(context, "Preview synthesis failed: ${e.message}", Toast.LENGTH_SHORT).show()
                    }
                }

                // Only resume one job at a time
                break
            }
        }
    }

    // Preview voice function - synthesizes sample text using the cloned voice
    fun previewVoice(voice: VoiceCloningService.ClonedVoice) {
        scope.launch {
            // Toggle off if already playing
            if (playingVoiceId == voice.id && !isPreviewLoading) {
                mediaPlayer?.release()
                mediaPlayer = null
                playingVoiceId = null
                showNotifyWhenReady = false
                notifyWhenReadyVoiceId = null
                return@launch
            }

            // Stop current playback
            mediaPlayer?.release()
            mediaPlayer = null
            showNotifyWhenReady = false
            notifyWhenReadyVoiceId = null

            playingVoiceId = voice.id
            previewProgress = 0f
            previewStatusMessage = "Starting..."

            // Check for cached preview first (try both .wav and .mp3)
            val cachedWavFile = File(previewCacheDir, "preview_${voice.id}.wav")
            val cachedMp3File = File(previewCacheDir, "preview_${voice.id}.mp3")
            val cachedFile = when {
                cachedWavFile.exists() -> cachedWavFile
                cachedMp3File.exists() -> cachedMp3File
                else -> null
            }
            if (cachedFile != null) {
                try {
                    mediaPlayer = MediaPlayer().apply {
                        setDataSource(cachedFile.absolutePath)
                        setOnPreparedListener { start() }
                        setOnCompletionListener {
                            playingVoiceId = null
                            release()
                            mediaPlayer = null
                        }
                        setOnErrorListener { _, _, _ ->
                            playingVoiceId = null
                            // Cache might be corrupted, delete and retry
                            cachedFile.delete()
                            Toast.makeText(context, "Failed to play preview", Toast.LENGTH_SHORT).show()
                            true
                        }
                        prepareAsync()
                    }
                    return@launch
                } catch (e: Exception) {
                    cachedFile.delete()
                }
            }

            // No cache - synthesize preview using TTS with progress tracking
            isPreviewLoading = true

            // Start timer to show "Notify when ready" option after 5 seconds
            val notifyJob = launch {
                kotlinx.coroutines.delay(5000)
                if (isPreviewLoading && playingVoiceId == voice.id) {
                    showNotifyWhenReady = true
                    notifyWhenReadyVoiceId = voice.id
                }
            }

            try {
                // Create a VoicePreset for the cloned voice
                val voicePreset = voice.toVoicePreset()

                // Synthesize sample text with progress callback
                val result = withContext(Dispatchers.IO) {
                    ttsCoordinator.synthesize(
                        text = sampleText,
                        voice = voicePreset,
                        options = SynthesisOptions(speed = 1.0f)
                    ) { progress ->
                        // Update progress on main thread
                        previewProgress = progress.overallProgress
                        previewStatusMessage = progress.statusMessage ?: "Synthesizing..."
                    }
                }

                notifyJob.cancel()
                showNotifyWhenReady = false
                notifyWhenReadyVoiceId = null

                // Copy to cache - cloned voices use .wav format
                val newCacheFile = File(previewCacheDir, "preview_${voice.id}.wav")
                result.audioFile.copyTo(newCacheFile, overwrite = true)

                isPreviewLoading = false
                previewProgress = 1f
                previewStatusMessage = "Complete"

                // Show notification if user opted in
                if (notifyWhenReadyVoiceId == voice.id) {
                    ttsNotificationService.showVoiceClonePreviewReady(
                        voiceId = voice.id,
                        voiceName = voice.name
                    )
                }

                // Play the synthesized audio
                mediaPlayer = MediaPlayer().apply {
                    setDataSource(result.audioFile.absolutePath)
                    setOnPreparedListener { start() }
                    setOnCompletionListener {
                        playingVoiceId = null
                        release()
                        mediaPlayer = null
                    }
                    setOnErrorListener { _, _, _ ->
                        playingVoiceId = null
                        Toast.makeText(context, "Failed to play preview", Toast.LENGTH_SHORT).show()
                        true
                    }
                    prepareAsync()
                }
            } catch (e: Exception) {
                notifyJob.cancel()
                isPreviewLoading = false
                playingVoiceId = null
                showNotifyWhenReady = false
                notifyWhenReadyVoiceId = null
                previewProgress = 0f
                previewStatusMessage = ""
                android.util.Log.e("VoiceCloningList", "Failed to synthesize preview", e)
                Toast.makeText(context, "Failed to generate preview: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // Handle "Notify me when ready" button
    fun enableNotifyWhenReady(voice: VoiceCloningService.ClonedVoice) {
        notifyWhenReadyVoiceId = voice.id
        showNotifyWhenReady = false
        Toast.makeText(context, "We'll notify you when the preview is ready", Toast.LENGTH_SHORT).show()
    }

    // Delete voice function
    fun deleteVoice(voice: VoiceCloningService.ClonedVoice) {
        scope.launch {
            isDeleting = true
            try {
                voiceCloningService.deleteClonedVoice(voice.id)
                clonedVoices = clonedVoices.filter { it.id != voice.id }
                Toast.makeText(context, "Voice deleted", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(context, "Failed to delete voice", Toast.LENGTH_SHORT).show()
            } finally {
                isDeleting = false
                voiceToDelete = null
            }
        }
    }

    // Rename voice function
    fun renameVoice(voice: VoiceCloningService.ClonedVoice, newName: String) {
        scope.launch {
            isRenaming = true
            try {
                val updatedVoice = voiceCloningService.updateClonedVoice(voice.id, name = newName)
                clonedVoices = clonedVoices.map { if (it.id == voice.id) updatedVoice else it }
                Toast.makeText(context, "Voice renamed", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(context, "Failed to rename voice", Toast.LENGTH_SHORT).show()
            } finally {
                isRenaming = false
                voiceToRename = null
                newVoiceName = ""
            }
        }
    }

    // Delete confirmation dialog
    voiceToDelete?.let { voice ->
        AlertDialog(
            onDismissRequest = { voiceToDelete = null },
            title = { Text("Delete Voice Clone?") },
            text = {
                Text("This will permanently delete '${voice.name}'. This action cannot be undone.")
            },
            confirmButton = {
                TextButton(
                    onClick = { deleteVoice(voice) },
                    enabled = !isDeleting
                ) {
                    if (isDeleting) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp
                        )
                    } else {
                        Text("Delete", color = Red)
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = { voiceToDelete = null }) {
                    Text("Cancel")
                }
            }
        )
    }

    // Rename dialog
    voiceToRename?.let { voice ->
        LaunchedEffect(voice) {
            newVoiceName = voice.name
        }

        AlertDialog(
            onDismissRequest = {
                voiceToRename = null
                newVoiceName = ""
            },
            title = { Text("Rename Voice Clone") },
            text = {
                OutlinedTextField(
                    value = newVoiceName,
                    onValueChange = { newVoiceName = it },
                    label = { Text("Voice Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            },
            confirmButton = {
                TextButton(
                    onClick = { renameVoice(voice, newVoiceName) },
                    enabled = !isRenaming && newVoiceName.isNotBlank() && newVoiceName != voice.name
                ) {
                    if (isRenaming) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp
                        )
                    } else {
                        Text("Save")
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = {
                    voiceToRename = null
                    newVoiceName = ""
                }) {
                    Text("Cancel")
                }
            }
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Voice Cloning", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (clonedVoices.isNotEmpty()) {
                        TextButton(onClick = { isEditing = !isEditing }) {
                            Text(
                                text = if (isEditing) "Done" else "Edit",
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            // Content area
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
            ) {
                when {
                    isLoading -> {
                        // Loading state
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator()
                        }
                    }
                    clonedVoices.isEmpty() -> {
                        // Empty state
                        EmptyVoiceState()
                    }
                    else -> {
                        // Voice list
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            items(clonedVoices, key = { it.id }) { voice ->
                                ClonedVoiceCard(
                                    voice = voice,
                                    isPlaying = playingVoiceId == voice.id && !isPreviewLoading,
                                    isLoading = playingVoiceId == voice.id && isPreviewLoading,
                                    isEditing = isEditing,
                                    progress = if (playingVoiceId == voice.id) previewProgress else 0f,
                                    showNotifyOption = showNotifyWhenReady && notifyWhenReadyVoiceId == voice.id,
                                    onPreview = { previewVoice(voice) },
                                    onRename = { voiceToRename = voice },
                                    onDelete = { voiceToDelete = voice },
                                    onNotifyWhenReady = { enableNotifyWhenReady(voice) }
                                )
                            }
                        }
                    }
                }
            }

            // Clone Voice button
            Button(
                onClick = onNavigateToCloneFlow,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 16.dp)
                    .height(56.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color.Black,
                    contentColor = Color.White
                ),
                shape = RoundedCornerShape(12.dp)
            ) {
                Icon(
                    Icons.Default.Mic,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "Clone Voice",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }
    }
}

@Composable
private fun EmptyVoiceState() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        // Microphone icon with waveform
        Box(contentAlignment = Alignment.Center) {
            Icon(
                Icons.Default.Mic,
                contentDescription = null,
                modifier = Modifier.size(64.dp),
                tint = MaterialTheme.colorScheme.outlineVariant
            )
            Icon(
                Icons.Default.GraphicEq,
                contentDescription = null,
                modifier = Modifier
                    .size(32.dp)
                    .offset(x = 30.dp, y = 10.dp),
                tint = MaterialTheme.colorScheme.outline
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = "No cloned voice here",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "You haven't created any voice clones yet.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun ClonedVoiceCard(
    voice: VoiceCloningService.ClonedVoice,
    isPlaying: Boolean,
    isLoading: Boolean,
    isEditing: Boolean,
    progress: Float = 0f,
    showNotifyOption: Boolean = false,
    onPreview: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
    onNotifyWhenReady: () -> Unit = {}
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Avatar placeholder
                Box(
                    modifier = Modifier
                        .size(64.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(MaterialTheme.colorScheme.surface),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        Icons.Default.Person,
                        contentDescription = null,
                        modifier = Modifier.size(32.dp),
                        tint = MaterialTheme.colorScheme.outlineVariant
                    )
                }

                // Voice info
                Column(modifier = Modifier.weight(1f)) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = voice.name,
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        Icon(
                            Icons.Default.Mic,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }

                    // Show status text
                    Text(
                        text = "Cloned Voice • Multilingual",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    Spacer(modifier = Modifier.height(4.dp))

                    // Progress bar when loading, waveform otherwise
                    if (isLoading && progress > 0f) {
                        LinearProgressIndicator(
                            progress = { progress },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(4.dp)
                                .clip(RoundedCornerShape(2.dp)),
                            color = Yellow,
                            trackColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f)
                        )
                    } else {
                        WaveformVisualization(
                            isAnimating = isPlaying || isLoading,
                            color = when {
                                isLoading -> Yellow
                                isPlaying -> Yellow
                                else -> MaterialTheme.colorScheme.outline
                            }
                        )
                    }
                }

                // Action buttons
                if (isEditing) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        IconButton(onClick = onRename) {
                            Icon(
                                Icons.Default.Edit,
                                contentDescription = "Rename",
                                tint = Blue,
                                modifier = Modifier.size(24.dp)
                            )
                        }
                        IconButton(onClick = onDelete) {
                            Icon(
                                Icons.Default.Delete,
                                contentDescription = "Delete",
                                tint = Red,
                                modifier = Modifier.size(24.dp)
                            )
                        }
                    }
                } else {
                    Button(
                        onClick = onPreview,
                        modifier = Modifier.size(44.dp),
                        shape = CircleShape,
                        colors = ButtonDefaults.buttonColors(containerColor = Yellow),
                        contentPadding = PaddingValues(0.dp)
                    ) {
                        if (isLoading) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp,
                                color = Color.Black
                            )
                        } else {
                            Icon(
                                imageVector = if (isPlaying) Icons.Default.Stop else Icons.Default.PlayArrow,
                                contentDescription = if (isPlaying) "Stop" else "Play",
                                tint = Color.Black,
                                modifier = Modifier.size(20.dp)
                            )
                        }
                    }
                }
            }

            // "Notify me when ready" option - shown after 5 seconds of synthesis
            if (showNotifyOption) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp)
                        .padding(bottom = 12.dp),
                    horizontalArrangement = Arrangement.Center
                ) {
                    TextButton(
                        onClick = onNotifyWhenReady,
                        colors = ButtonDefaults.textButtonColors(
                            contentColor = Blue
                        )
                    ) {
                        Icon(
                            Icons.Default.Notifications,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text(
                            text = "Notify me when ready",
                            style = MaterialTheme.typography.labelMedium
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun WaveformVisualization(
    isAnimating: Boolean,
    color: Color
) {
    val infiniteTransition = rememberInfiniteTransition(label = "waveform")
    val animationProgress by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(300, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "waveform"
    )

    val heights = remember {
        listOf(6, 10, 14, 10, 8, 12, 16, 12, 8, 14, 10, 6, 8, 12, 10, 14, 8, 10, 12, 8, 6, 10, 8, 6)
    }

    Row(
        horizontalArrangement = Arrangement.spacedBy(1.dp),
        modifier = Modifier.height(16.dp)
    ) {
        heights.forEachIndexed { index, baseHeight ->
            val height = if (isAnimating) {
                val multiplier = 0.7f + (animationProgress * 0.6f * if (index % 2 == 0) 1f else -1f)
                (baseHeight * multiplier).coerceIn(4f, 16f)
            } else {
                baseHeight.toFloat()
            }

            Box(
                modifier = Modifier
                    .width(2.dp)
                    .height(height.dp)
                    .clip(RoundedCornerShape(1.dp))
                    .background(color)
            )
        }
    }
}
