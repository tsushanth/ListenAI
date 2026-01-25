package com.listenai.ui.marketplace

import android.media.MediaPlayer
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.unit.dp
import com.listenai.service.marketplace.VoiceMarketplaceService
import com.listenai.service.marketplace.VoiceMarketplaceService.SharedVoice
import com.listenai.service.marketplace.VoiceMarketplaceService.ReportReason
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceDetailScreen(
    voiceId: String,
    onNavigateBack: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val marketplaceService = remember { VoiceMarketplaceService.getInstance(context) }

    var voice by remember { mutableStateOf<SharedVoice?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    var isPlaying by remember { mutableStateOf(false) }
    var mediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }

    var showRatingDialog by remember { mutableStateOf(false) }
    var showReportDialog by remember { mutableStateOf(false) }
    var userRating by remember { mutableStateOf(0) }
    var userReview by remember { mutableStateOf("") }
    var selectedReportReason by remember { mutableStateOf(ReportReason.OTHER) }
    var reportDescription by remember { mutableStateOf("") }

    val dateFormat = remember { SimpleDateFormat("MMM d, yyyy", Locale.getDefault()) }

    fun loadVoice() {
        scope.launch {
            isLoading = true
            errorMessage = null
            try {
                voice = marketplaceService.getVoice(voiceId)
            } catch (e: Exception) {
                errorMessage = e.message ?: "Failed to load voice"
            } finally {
                isLoading = false
            }
        }
    }

    fun playPreview() {
        voice?.previewAudioUrl?.let { url ->
            if (isPlaying) {
                mediaPlayer?.stop()
                mediaPlayer?.release()
                mediaPlayer = null
                isPlaying = false
            } else {
                try {
                    mediaPlayer = MediaPlayer().apply {
                        setDataSource(url)
                        setOnCompletionListener {
                            isPlaying = false
                            release()
                            mediaPlayer = null
                        }
                        setOnErrorListener { _, _, _ ->
                            isPlaying = false
                            release()
                            mediaPlayer = null
                            true
                        }
                        prepareAsync()
                        setOnPreparedListener {
                            start()
                            isPlaying = true
                        }
                    }
                } catch (e: Exception) {
                    errorMessage = "Failed to play preview"
                }
            }
        }
    }

    fun submitRating() {
        scope.launch {
            try {
                marketplaceService.rateVoice(voiceId, userRating, userReview.takeIf { it.isNotEmpty() })
                showRatingDialog = false
                loadVoice() // Refresh to get updated rating
            } catch (e: Exception) {
                errorMessage = e.message
            }
        }
    }

    fun submitReport() {
        scope.launch {
            try {
                marketplaceService.reportVoice(voiceId, selectedReportReason, reportDescription)
                showReportDialog = false
                // Show success message
            } catch (e: Exception) {
                errorMessage = e.message
            }
        }
    }

    LaunchedEffect(voiceId) {
        loadVoice()
    }

    DisposableEffect(Unit) {
        onDispose {
            mediaPlayer?.release()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Voice Details") },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (voice?.isOwn == false) {
                        IconButton(onClick = { showReportDialog = true }) {
                            Icon(Icons.Default.Flag, contentDescription = "Report")
                        }
                    }
                }
            )
        }
    ) { paddingValues ->
        when {
            isLoading -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator()
                }
            }
            errorMessage != null -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(errorMessage ?: "Error", color = MaterialTheme.colorScheme.error)
                        Spacer(modifier = Modifier.height(16.dp))
                        Button(onClick = { loadVoice() }) {
                            Text("Retry")
                        }
                    }
                }
            }
            voice != null -> {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues)
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    // Avatar
                    Box(
                        modifier = Modifier
                            .size(120.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.primaryContainer),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            Icons.Default.RecordVoiceOver,
                            contentDescription = null,
                            modifier = Modifier.size(60.dp),
                            tint = MaterialTheme.colorScheme.onPrimaryContainer
                        )
                    }

                    Spacer(modifier = Modifier.height(16.dp))

                    Text(
                        text = voice!!.displayName,
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold
                    )

                    if (voice!!.description != null) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = voice!!.description!!,
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }

                    Spacer(modifier = Modifier.height(16.dp))

                    // Stats row
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly
                    ) {
                        StatItem(
                            icon = Icons.Default.Star,
                            value = String.format("%.1f", voice!!.avgRating),
                            label = "${voice!!.ratingCount} ratings",
                            iconTint = Color(0xFFFFB800)
                        )
                        StatItem(
                            icon = Icons.Default.PlayArrow,
                            value = "${voice!!.usageCount}",
                            label = "uses"
                        )
                        voice!!.createdAt?.let { date ->
                            StatItem(
                                icon = Icons.Default.DateRange,
                                value = dateFormat.format(date),
                                label = "created"
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(24.dp))

                    // Tags
                    if (voice!!.tags.isNotEmpty()) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.Center
                        ) {
                            voice!!.tags.forEach { tag ->
                                Surface(
                                    modifier = Modifier.padding(4.dp),
                                    shape = RoundedCornerShape(16.dp),
                                    color = MaterialTheme.colorScheme.secondaryContainer
                                ) {
                                    Text(
                                        text = tag,
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.onSecondaryContainer
                                    )
                                }
                            }
                        }
                        Spacer(modifier = Modifier.height(24.dp))
                    }

                    // Play preview button
                    if (voice!!.previewAudioUrl != null) {
                        Button(
                            onClick = { playPreview() },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(56.dp),
                            shape = RoundedCornerShape(28.dp)
                        ) {
                            Icon(
                                if (isPlaying) Icons.Default.Stop else Icons.Default.PlayArrow,
                                contentDescription = null
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(if (isPlaying) "Stop Preview" else "Play Preview")
                        }

                        Spacer(modifier = Modifier.height(16.dp))
                    }

                    // Rate button
                    if (voice!!.isOwn == false) {
                        OutlinedButton(
                            onClick = { showRatingDialog = true },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(56.dp),
                            shape = RoundedCornerShape(28.dp)
                        ) {
                            Icon(Icons.Default.Star, contentDescription = null)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Rate this Voice")
                        }
                    }
                }
            }
        }
    }

    // Rating Dialog
    if (showRatingDialog) {
        AlertDialog(
            onDismissRequest = { showRatingDialog = false },
            title = { Text("Rate Voice") },
            text = {
                Column {
                    Text("How would you rate this voice?")
                    Spacer(modifier = Modifier.height(16.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.Center
                    ) {
                        (1..5).forEach { star ->
                            IconButton(onClick = { userRating = star }) {
                                Icon(
                                    if (star <= userRating) Icons.Default.Star else Icons.Default.StarBorder,
                                    contentDescription = "$star stars",
                                    tint = if (star <= userRating) Color(0xFFFFB800) else MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.size(36.dp)
                                )
                            }
                        }
                    }
                    Spacer(modifier = Modifier.height(16.dp))
                    OutlinedTextField(
                        value = userReview,
                        onValueChange = { userReview = it },
                        label = { Text("Review (optional)") },
                        modifier = Modifier.fillMaxWidth(),
                        maxLines = 3
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = { submitRating() },
                    enabled = userRating > 0
                ) {
                    Text("Submit")
                }
            },
            dismissButton = {
                TextButton(onClick = { showRatingDialog = false }) {
                    Text("Cancel")
                }
            }
        )
    }

    // Report Dialog
    if (showReportDialog) {
        AlertDialog(
            onDismissRequest = { showReportDialog = false },
            title = { Text("Report Voice") },
            text = {
                Column {
                    Text("Why are you reporting this voice?")
                    Spacer(modifier = Modifier.height(16.dp))
                    ReportReason.values().forEach { reason ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            RadioButton(
                                selected = selectedReportReason == reason,
                                onClick = { selectedReportReason = reason }
                            )
                            Text(reason.displayName)
                        }
                    }
                    Spacer(modifier = Modifier.height(16.dp))
                    OutlinedTextField(
                        value = reportDescription,
                        onValueChange = { reportDescription = it },
                        label = { Text("Description") },
                        modifier = Modifier.fillMaxWidth(),
                        maxLines = 3
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = { submitReport() },
                    enabled = reportDescription.isNotEmpty()
                ) {
                    Text("Submit Report")
                }
            },
            dismissButton = {
                TextButton(onClick = { showReportDialog = false }) {
                    Text("Cancel")
                }
            }
        )
    }
}

@Composable
private fun StatItem(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    value: String,
    label: String,
    iconTint: Color = MaterialTheme.colorScheme.primary
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(
            icon,
            contentDescription = null,
            tint = iconTint,
            modifier = Modifier.size(24.dp)
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = value,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold
        )
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}
