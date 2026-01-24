package com.listenai.ui.voice

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.listenai.data.models.VoiceCategory
import com.listenai.data.models.VoiceGender
import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceProvider
import com.listenai.data.models.VoiceQuality
import com.listenai.data.models.VoiceStyle
import com.listenai.data.models.VoiceTier
import com.listenai.service.voice.VoiceCloningService
import com.listenai.ui.theme.Blue
import com.listenai.ui.theme.Green
import com.listenai.ui.theme.Pink
import com.listenai.ui.theme.Purple
import com.listenai.ui.theme.Red
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.koin.compose.koinInject
import android.media.MediaPlayer
import android.widget.Toast
import com.listenai.service.tts.TTSCoordinator
import com.listenai.service.tts.SynthesisOptions
import com.listenai.ui.theme.Yellow
import java.io.File

/**
 * Voice picker bottom sheet dialog for selecting a voice in article view
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoicePickerBottomSheet(
    voices: List<VoicePreset>,
    selectedVoice: VoicePreset?,
    hasGeneratedAudio: Boolean = false,
    onVoiceSelected: (VoicePreset) -> Unit,
    onRegenerateWithVoice: (VoicePreset) -> Unit = {},
    onNavigateToVoiceCloning: () -> Unit = {},
    onDismiss: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val voiceCloningService: VoiceCloningService = koinInject()
    val ttsCoordinator: TTSCoordinator = koinInject()

    // Sample text for voice preview (same as iOS)
    val sampleText = "Hello, this is a preview of your cloned voice. I can read your articles with this unique sound."

    // Preview cache directory
    val previewCacheDir = remember { File(context.cacheDir, "cloned_voice_previews").apply { mkdirs() } }

    val displayedVoices = voices.ifEmpty { VoicePreset.builtInVoices }
    var tempSelectedVoice by remember { mutableStateOf(selectedVoice) }
    val voiceChanged = tempSelectedVoice != null && tempSelectedVoice?.id != selectedVoice?.id

    // Load cloned voices
    var clonedVoices by remember { mutableStateOf<List<VoiceCloningService.ClonedVoice>>(emptyList()) }
    var isLoadingCloned by remember { mutableStateOf(true) }

    // Audio playback state
    var mediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }
    var playingVoiceId by remember { mutableStateOf<String?>(null) }
    var isPreviewLoading by remember { mutableStateOf(false) }

    // Delete confirmation dialog state
    var voiceToDelete by remember { mutableStateOf<VoiceCloningService.ClonedVoice?>(null) }
    var isDeleting by remember { mutableStateOf(false) }

    // Cleanup media player on dismiss
    DisposableEffect(Unit) {
        onDispose {
            mediaPlayer?.release()
            mediaPlayer = null
        }
    }

    LaunchedEffect(Unit) {
        scope.launch {
            try {
                clonedVoices = voiceCloningService.listClonedVoices(forceRefresh = true)
            } catch (e: Exception) {
                android.util.Log.e("VoicePickerBottomSheet", "Failed to load cloned voices", e)
            } finally {
                isLoadingCloned = false
            }
        }
    }

    // Preview voice function - synthesizes sample text using the cloned voice
    fun playPreview(voice: VoiceCloningService.ClonedVoice) {
        scope.launch {
            // Toggle off if already playing
            if (playingVoiceId == voice.id && !isPreviewLoading) {
                mediaPlayer?.release()
                mediaPlayer = null
                playingVoiceId = null
                return@launch
            }

            // Stop current playback
            mediaPlayer?.release()
            mediaPlayer = null

            playingVoiceId = voice.id

            // Check for cached preview first
            val cachedFile = File(previewCacheDir, "preview_${voice.id}.mp3")
            if (cachedFile.exists()) {
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

            // No cache - synthesize preview using TTS
            isPreviewLoading = true

            try {
                // Create a VoicePreset for the cloned voice
                val voicePreset = voice.toVoicePreset()

                // Synthesize sample text
                val result = withContext(Dispatchers.IO) {
                    ttsCoordinator.synthesize(
                        text = sampleText,
                        voice = voicePreset,
                        options = SynthesisOptions(speed = 1.0f)
                    ) { /* ignore progress */ }
                }

                // Copy to cache
                result.audioFile.copyTo(cachedFile, overwrite = true)

                isPreviewLoading = false

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
                isPreviewLoading = false
                playingVoiceId = null
                android.util.Log.e("VoicePickerBottomSheet", "Failed to synthesize preview", e)
                Toast.makeText(context, "Failed to generate preview: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // Function to delete a voice
    fun deleteVoice(voice: VoiceCloningService.ClonedVoice) {
        scope.launch {
            isDeleting = true
            try {
                voiceCloningService.deleteClonedVoice(voice.id)
                clonedVoices = clonedVoices.filter { it.id != voice.id }
                Toast.makeText(context, "Voice deleted", Toast.LENGTH_SHORT).show()

                // Clear selection if deleted voice was selected
                if (tempSelectedVoice?.id == "cloned_${voice.id}") {
                    tempSelectedVoice = null
                }
            } catch (e: Exception) {
                android.util.Log.e("VoicePickerBottomSheet", "Failed to delete voice", e)
                Toast.makeText(context, "Failed to delete voice", Toast.LENGTH_SHORT).show()
            } finally {
                isDeleting = false
                voiceToDelete = null
            }
        }
    }

    // Delete confirmation dialog
    voiceToDelete?.let { voice ->
        AlertDialog(
            onDismissRequest = { voiceToDelete = null },
            title = { Text("Delete Voice?") },
            text = { Text("Are you sure you want to delete \"${voice.name}\"? This action cannot be undone.") },
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

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            dismissOnBackPress = true,
            dismissOnClickOutside = true
        )
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.75f)
                .padding(top = 48.dp),
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
            color = MaterialTheme.colorScheme.surface
        ) {
            Column(
                modifier = Modifier.fillMaxSize()
            ) {
                // Handle bar
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 12.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Box(
                        modifier = Modifier
                            .width(40.dp)
                            .height(4.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(MaterialTheme.colorScheme.outlineVariant)
                    )
                }

                // Title
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "Select Voice",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold
                    )
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close")
                    }
                }

                HorizontalDivider()

                // Voice list
                LazyColumn(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    contentPadding = PaddingValues(vertical = 8.dp)
                ) {
                    // Cloned voices section
                    if (clonedVoices.isNotEmpty() || !isLoadingCloned) {
                        item {
                            ClonedVoicesSection(
                                clonedVoices = clonedVoices,
                                isLoading = isLoadingCloned,
                                selectedVoiceId = tempSelectedVoice?.id,
                                playingVoiceId = playingVoiceId,
                                isPreviewLoading = isPreviewLoading,
                                onClonedVoiceSelected = { clonedVoice ->
                                    // Convert ClonedVoice to VoicePreset
                                    tempSelectedVoice = clonedVoice.toVoicePreset()
                                },
                                onPlayPreview = { voice -> playPreview(voice) },
                                onDeleteVoice = { voice -> voiceToDelete = voice },
                                onCreateNewClone = {
                                    onDismiss()
                                    onNavigateToVoiceCloning()
                                }
                            )
                        }

                        item {
                            Spacer(modifier = Modifier.height(8.dp))
                            Text(
                                text = "Built-in Voices",
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }

                    items(displayedVoices) { voice ->
                        VoiceItem(
                            voice = voice,
                            isSelected = tempSelectedVoice?.id == voice.id,
                            onSelect = { tempSelectedVoice = voice }
                        )
                    }
                }

                // Save/Regenerate button
                val showRegenerate = hasGeneratedAudio && voiceChanged
                Button(
                    onClick = {
                        tempSelectedVoice?.let { voice ->
                            if (showRegenerate) {
                                onRegenerateWithVoice(voice)
                            } else {
                                onVoiceSelected(voice)
                            }
                        }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    enabled = tempSelectedVoice != null,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (showRegenerate) Blue else Color.Black,
                        contentColor = Color.White
                    ),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    if (showRegenerate) {
                        Icon(
                            Icons.Default.Refresh,
                            contentDescription = null,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                    }
                    Text(
                        text = if (showRegenerate) "Regenerate with ${tempSelectedVoice?.name}" else "Save",
                        modifier = Modifier.padding(vertical = 8.dp),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }
    }
}

@Composable
private fun VoiceItem(
    voice: VoicePreset,
    isSelected: Boolean,
    onSelect: () -> Unit
) {
    val borderColor = if (isSelected) Blue else Color.Transparent
    val backgroundColor = if (isSelected) Blue.copy(alpha = 0.1f) else Color.Transparent

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onSelect)
            .background(backgroundColor)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Voice Avatar
        VoiceAvatar(voice = voice)

        // Voice Info
        Column(modifier = Modifier.weight(1f)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = voice.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )

                // Quality badge
                Surface(
                    shape = RoundedCornerShape(4.dp),
                    color = Blue.copy(alpha = 0.15f)
                ) {
                    Text(
                        text = "HD",
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        color = Blue
                    )
                }
            }

            Text(
                text = buildString {
                    append(voice.style.name.lowercase().replaceFirstChar { it.uppercase() })
                    append(" • ")
                    append(voice.gender.name.lowercase().replaceFirstChar { it.uppercase() })
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        // Selected checkmark
        if (isSelected) {
            Icon(
                imageVector = Icons.Default.CheckCircle,
                contentDescription = "Selected",
                tint = Blue
            )
        }
    }
}

@Composable
private fun VoiceAvatar(voice: VoicePreset) {
    // Use accent color from voice if available, otherwise fall back to gender-based color
    val accentColor = voice.accentColorHex?.let { parseHexColor(it) }
        ?: when (voice.gender) {
            VoiceGender.FEMALE -> Pink
            VoiceGender.MALE -> Blue
            VoiceGender.NEUTRAL -> Green
        }

    Box(
        modifier = Modifier
            .size(48.dp)
            .clip(CircleShape)
            .background(accentColor.copy(alpha = 0.2f)),
        contentAlignment = Alignment.Center
    ) {
        // Show avatar emoji if available, otherwise show initials
        if (voice.avatarEmoji != null) {
            Text(
                text = voice.avatarEmoji,
                style = MaterialTheme.typography.titleLarge
            )
        } else {
            Text(
                text = voice.name.take(2).uppercase(),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = accentColor
            )
        }
    }
}

/**
 * Parse hex color string to Color
 */
private fun parseHexColor(hex: String): Color {
    return try {
        val cleanHex = hex.removePrefix("#")
        val colorInt = android.graphics.Color.parseColor("#$cleanHex")
        Color(colorInt)
    } catch (e: Exception) {
        Blue // Default fallback
    }
}

/**
 * Cloned voices section with header and create button
 */
@Composable
private fun ClonedVoicesSection(
    clonedVoices: List<VoiceCloningService.ClonedVoice>,
    isLoading: Boolean,
    selectedVoiceId: String?,
    playingVoiceId: String?,
    isPreviewLoading: Boolean,
    onClonedVoiceSelected: (VoiceCloningService.ClonedVoice) -> Unit,
    onPlayPreview: (VoiceCloningService.ClonedVoice) -> Unit,
    onDeleteVoice: (VoiceCloningService.ClonedVoice) -> Unit,
    onCreateNewClone: () -> Unit
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        // Section header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "My Voices",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            TextButton(
                onClick = onCreateNewClone,
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)
            ) {
                Icon(
                    Icons.Default.Add,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = Purple
                )
                Spacer(modifier = Modifier.width(4.dp))
                Text(
                    text = "Clone Voice",
                    style = MaterialTheme.typography.labelMedium,
                    color = Purple
                )
            }
        }

        if (isLoading) {
            // Loading state
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 24.dp),
                contentAlignment = Alignment.Center
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(24.dp),
                    strokeWidth = 2.dp
                )
            }
        } else if (clonedVoices.isEmpty()) {
            // Empty state - prompt to create first clone
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp)
                    .clickable(onClick = onCreateNewClone),
                colors = CardDefaults.cardColors(containerColor = Purple.copy(alpha = 0.1f)),
                shape = RoundedCornerShape(12.dp)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        modifier = Modifier
                            .size(48.dp)
                            .clip(CircleShape)
                            .background(Purple.copy(alpha = 0.2f)),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            Icons.Default.RecordVoiceOver,
                            contentDescription = null,
                            tint = Purple,
                            modifier = Modifier.size(24.dp)
                        )
                    }

                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Clone Your Voice",
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            text = "Create a personalized voice from a recording",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }

                    Icon(
                        Icons.Default.ChevronRight,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        } else {
            // Show cloned voices
            clonedVoices.forEach { clonedVoice ->
                ClonedVoiceItem(
                    clonedVoice = clonedVoice,
                    isSelected = selectedVoiceId == "cloned_${clonedVoice.id}",
                    isPlaying = playingVoiceId == clonedVoice.id && !isPreviewLoading,
                    isLoadingPreview = playingVoiceId == clonedVoice.id && isPreviewLoading,
                    onSelect = { onClonedVoiceSelected(clonedVoice) },
                    onPlayPreview = { onPlayPreview(clonedVoice) },
                    onDelete = { onDeleteVoice(clonedVoice) }
                )
            }
        }
    }
}

/**
 * Cloned voice item in the list
 */
@Composable
private fun ClonedVoiceItem(
    clonedVoice: VoiceCloningService.ClonedVoice,
    isSelected: Boolean,
    isPlaying: Boolean,
    isLoadingPreview: Boolean,
    onSelect: () -> Unit,
    onPlayPreview: () -> Unit,
    onDelete: () -> Unit
) {
    val backgroundColor = if (isSelected) Purple.copy(alpha = 0.1f) else Color.Transparent

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onSelect)
            .background(backgroundColor)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Voice Avatar - use mic icon for cloned voices
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(CircleShape)
                .background(Purple.copy(alpha = 0.2f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                Icons.Default.RecordVoiceOver,
                contentDescription = null,
                tint = Purple,
                modifier = Modifier.size(24.dp)
            )
        }

        // Voice Info
        Column(modifier = Modifier.weight(1f)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = clonedVoice.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )

                // Cloned badge
                Surface(
                    shape = RoundedCornerShape(4.dp),
                    color = Purple.copy(alpha = 0.15f)
                ) {
                    Text(
                        text = "CLONED",
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        color = Purple
                    )
                }
            }

            Text(
                text = if (isLoadingPreview) "Generating preview..." else (clonedVoice.description ?: "Custom voice clone"),
                style = MaterialTheme.typography.bodySmall,
                color = if (isLoadingPreview) Yellow else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }

        // Play preview button
        IconButton(
            onClick = onPlayPreview,
            modifier = Modifier.size(36.dp),
            enabled = !isLoadingPreview
        ) {
            if (isLoadingPreview) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.dp,
                    color = Purple
                )
            } else {
                Icon(
                    imageVector = if (isPlaying) Icons.Default.Stop else Icons.Default.PlayArrow,
                    contentDescription = if (isPlaying) "Stop" else "Preview",
                    tint = Purple,
                    modifier = Modifier.size(20.dp)
                )
            }
        }

        // Delete button
        IconButton(
            onClick = onDelete,
            modifier = Modifier.size(36.dp)
        ) {
            Icon(
                imageVector = Icons.Default.Delete,
                contentDescription = "Delete",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp)
            )
        }

        // Selected checkmark
        if (isSelected) {
            Icon(
                imageVector = Icons.Default.CheckCircle,
                contentDescription = "Selected",
                tint = Purple
            )
        }
    }
}

/**
 * Convert ClonedVoice to VoicePreset for compatibility with existing TTS system
 */
fun VoiceCloningService.ClonedVoice.toVoicePreset(): VoicePreset {
    return VoicePreset(
        id = "cloned_$id",
        name = name,
        isBuiltIn = false,
        isCharacterVoice = false,
        provider = VoiceProvider.SELF_HOSTED,
        providerVoiceId = id,  // The cloned voice ID from backend
        providerModelId = "chatterbox",  // Chatterbox model for cloned voices
        quality = VoiceQuality.STANDARD,
        kokoroVoiceId = null,  // Not using Kokoro for cloned voices
        gender = VoiceGender.NEUTRAL,
        style = VoiceStyle.CONVERSATIONAL,
        category = VoiceCategory.CUSTOM,
        tier = VoiceTier.FREE,
        sampleAudioUrl = audioUrl,
        avatarEmoji = null,
        accentColorHex = "#AF52DE"  // Purple for cloned voices
    )
}
