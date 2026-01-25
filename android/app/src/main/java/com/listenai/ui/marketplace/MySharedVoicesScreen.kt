package com.listenai.ui.marketplace

import androidx.compose.foundation.background
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
import com.listenai.service.marketplace.VoiceMarketplaceService
import com.listenai.service.marketplace.VoiceMarketplaceService.MySharedVoice
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MySharedVoicesScreen(
    onNavigateBack: () -> Unit,
    onNavigateToShare: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val marketplaceService = remember { VoiceMarketplaceService.getInstance(context) }

    var shares by remember { mutableStateOf<List<MySharedVoice>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var voiceToRevoke by remember { mutableStateOf<MySharedVoice?>(null) }

    val dateFormat = remember { SimpleDateFormat("MMM d, yyyy", Locale.getDefault()) }

    fun loadShares() {
        scope.launch {
            isLoading = true
            errorMessage = null
            try {
                shares = marketplaceService.getMyShares()
            } catch (e: Exception) {
                errorMessage = e.message ?: "Failed to load shares"
            } finally {
                isLoading = false
            }
        }
    }

    fun revokeVoice(voice: MySharedVoice) {
        scope.launch {
            try {
                marketplaceService.revokeVoice(voice.id)
                voiceToRevoke = null
                loadShares()
            } catch (e: Exception) {
                errorMessage = e.message
            }
        }
    }

    LaunchedEffect(Unit) {
        loadShares()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("My Shared Voices") },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = onNavigateToShare,
                containerColor = MaterialTheme.colorScheme.primary
            ) {
                Icon(Icons.Default.Add, contentDescription = "Share Voice")
            }
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
                        Button(onClick = { loadShares() }) {
                            Text("Retry")
                        }
                    }
                }
            }
            shares.isEmpty() -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.padding(32.dp)
                    ) {
                        Icon(
                            Icons.Default.Share,
                            contentDescription = null,
                            modifier = Modifier.size(64.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Text(
                            "No shared voices yet",
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            "Share your cloned voices with the community and earn rewards when others use them!",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp)
                        )
                        Spacer(modifier = Modifier.height(24.dp))
                        Button(onClick = onNavigateToShare) {
                            Icon(Icons.Default.Add, contentDescription = null)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Share a Voice")
                        }
                    }
                }
            }
            else -> {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    items(shares) { share ->
                        SharedVoiceCard(
                            share = share,
                            dateFormat = dateFormat,
                            onRevoke = { voiceToRevoke = share }
                        )
                    }
                }
            }
        }
    }

    // Revoke confirmation dialog
    voiceToRevoke?.let { voice ->
        AlertDialog(
            onDismissRequest = { voiceToRevoke = null },
            title = { Text("Revoke Voice") },
            text = {
                Text("Are you sure you want to stop sharing \"${voice.displayName}\"? Others will no longer be able to use this voice.")
            },
            confirmButton = {
                TextButton(
                    onClick = { revokeVoice(voice) },
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
                ) {
                    Text("Revoke")
                }
            },
            dismissButton = {
                TextButton(onClick = { voiceToRevoke = null }) {
                    Text("Cancel")
                }
            }
        )
    }
}

@Composable
private fun SharedVoiceCard(
    share: MySharedVoice,
    dateFormat: SimpleDateFormat,
    onRevoke: () -> Unit
) {
    val isRevoked = share.status == "revoked"
    val statusColor = when (share.status) {
        "active" -> Color(0xFF4CAF50)
        "pending" -> Color(0xFFFF9800)
        "revoked" -> Color(0xFFF44336)
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // Avatar
                Box(
                    modifier = Modifier
                        .size(48.dp)
                        .clip(CircleShape)
                        .background(
                            if (isRevoked) MaterialTheme.colorScheme.surfaceVariant
                            else MaterialTheme.colorScheme.primaryContainer
                        ),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        Icons.Default.RecordVoiceOver,
                        contentDescription = null,
                        modifier = Modifier.size(24.dp),
                        tint = if (isRevoked) MaterialTheme.colorScheme.onSurfaceVariant
                        else MaterialTheme.colorScheme.onPrimaryContainer
                    )
                }

                Spacer(modifier = Modifier.width(12.dp))

                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = share.displayName,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )

                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Surface(
                            shape = RoundedCornerShape(4.dp),
                            color = statusColor.copy(alpha = 0.2f)
                        ) {
                            Text(
                                text = share.status.replaceFirstChar { it.uppercase() },
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                                style = MaterialTheme.typography.labelSmall,
                                color = statusColor
                            )
                        }

                        share.createdAt?.let { date ->
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = dateFormat.format(date),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }

                if (!isRevoked) {
                    IconButton(onClick = onRevoke) {
                        Icon(
                            Icons.Default.Delete,
                            contentDescription = "Revoke",
                            tint = MaterialTheme.colorScheme.error
                        )
                    }
                }
            }

            if (share.revokedReason != null) {
                Spacer(modifier = Modifier.height(8.dp))
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = MaterialTheme.colorScheme.errorContainer
                ) {
                    Row(
                        modifier = Modifier.padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            Icons.Default.Warning,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = "Revoked: ${share.revokedReason}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Stats
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceAround
            ) {
                StatColumn(
                    icon = Icons.Default.Star,
                    value = String.format("%.1f", share.avgRating),
                    label = "${share.ratingCount} ratings",
                    iconTint = Color(0xFFFFB800)
                )
                StatColumn(
                    icon = Icons.Default.PlayArrow,
                    value = "${share.usageCount}",
                    label = "uses"
                )
            }

            // Tags
            if (share.tags.isNotEmpty()) {
                Spacer(modifier = Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    share.tags.take(4).forEach { tag ->
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = MaterialTheme.colorScheme.secondaryContainer
                        ) {
                            Text(
                                text = tag,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSecondaryContainer
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun StatColumn(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    value: String,
    label: String,
    iconTint: Color = MaterialTheme.colorScheme.primary
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                icon,
                contentDescription = null,
                tint = iconTint,
                modifier = Modifier.size(16.dp)
            )
            Spacer(modifier = Modifier.width(4.dp))
            Text(
                text = value,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold
            )
        }
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}
