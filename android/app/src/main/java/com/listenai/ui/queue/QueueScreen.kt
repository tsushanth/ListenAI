package com.listenai.ui.queue

import androidx.compose.ui.res.stringResource
import com.listenai.R
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.listenai.service.playback.QueueItem
import com.listenai.service.playback.QueueManager
import com.listenai.ui.theme.*
import org.koin.compose.koinInject

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QueueScreen(
    onNavigateBack: () -> Unit,
    onPlayItem: (String) -> Unit,
    queueManager: QueueManager = koinInject()
) {
    val queue by queueManager.queue.collectAsState()
    val currentItem by queueManager.currentItem.collectAsState()
    val isShuffleEnabled by queueManager.isShuffleEnabled.collectAsState()
    val repeatMode by queueManager.repeatMode.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.up_next), fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    if (queue.isNotEmpty()) {
                        IconButton(onClick = { queueManager.clearQueue() }) {
                            Icon(Icons.Default.ClearAll, contentDescription = stringResource(R.string.queue_clear))
                        }
                    }
                }
            )
        }
    ) { paddingValues ->
        if (queue.isEmpty()) {
            // Empty state
            EmptyQueueState(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
            )
        } else {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
            ) {
                // Queue controls
                QueueControls(
                    isShuffleEnabled = isShuffleEnabled,
                    repeatMode = repeatMode,
                    totalItems = queue.size,
                    totalDuration = queueManager.totalDuration(),
                    onToggleShuffle = { queueManager.toggleShuffle() },
                    onCycleRepeat = { queueManager.cycleRepeatMode() }
                )

                // Queue list
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    itemsIndexed(queue, key = { _, item -> item.id }) { _, item ->
                        QueueItemCard(
                            item = item,
                            isCurrentlyPlaying = item.id == currentItem?.id,
                            onPlay = { onPlayItem(item.article.id) },
                            onRemove = { queueManager.removeFromQueue(item.id) }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyQueueState(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Box(
            modifier = Modifier
                .size(80.dp)
                .clip(CircleShape)
                .background(Blue.copy(alpha = 0.1f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                Icons.Default.QueueMusic,
                contentDescription = null,
                modifier = Modifier.size(40.dp),
                tint = Blue
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = stringResource(R.string.queue_empty_title),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = stringResource(R.string.queue_empty_description),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun QueueControls(
    isShuffleEnabled: Boolean,
    repeatMode: QueueManager.RepeatMode,
    totalItems: Int,
    totalDuration: Long,
    onToggleShuffle: () -> Unit,
    onCycleRepeat: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Queue info
            Column {
                Text(
                    text = androidx.compose.ui.res.pluralStringResource(R.plurals.queue_item_count, totalItems, totalItems),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = formatDuration(totalDuration),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Controls
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                // Shuffle button
                IconButton(
                    onClick = onToggleShuffle,
                    colors = IconButtonDefaults.iconButtonColors(
                        containerColor = if (isShuffleEnabled) Blue.copy(alpha = 0.15f) else Color.Transparent
                    )
                ) {
                    Icon(
                        Icons.Default.Shuffle,
                        contentDescription = stringResource(R.string.queue_shuffle),
                        tint = if (isShuffleEnabled) Blue else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                // Repeat button
                IconButton(
                    onClick = onCycleRepeat,
                    colors = IconButtonDefaults.iconButtonColors(
                        containerColor = if (repeatMode != QueueManager.RepeatMode.OFF) Blue.copy(alpha = 0.15f) else Color.Transparent
                    )
                ) {
                    Icon(
                        imageVector = when (repeatMode) {
                            QueueManager.RepeatMode.ONE -> Icons.Default.RepeatOne
                            else -> Icons.Default.Repeat
                        },
                        contentDescription = stringResource(R.string.queue_repeat),
                        tint = if (repeatMode != QueueManager.RepeatMode.OFF) Blue else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun QueueItemCard(
    item: QueueItem,
    isCurrentlyPlaying: Boolean,
    onPlay: () -> Unit,
    onRemove: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (isCurrentlyPlaying) {
                    Modifier.shadow(4.dp, RoundedCornerShape(12.dp))
                } else {
                    Modifier
                }
            ),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (isCurrentlyPlaying) {
                Blue.copy(alpha = 0.1f)
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            }
        ),
        onClick = onPlay
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Now playing indicator or drag handle
            Box(
                modifier = Modifier.size(40.dp),
                contentAlignment = Alignment.Center
            ) {
                if (isCurrentlyPlaying) {
                    Icon(
                        Icons.Default.GraphicEq,
                        contentDescription = stringResource(R.string.now_playing),
                        tint = Blue,
                        modifier = Modifier.size(24.dp)
                    )
                } else {
                    Icon(
                        Icons.Default.DragHandle,
                        contentDescription = stringResource(R.string.queue_drag_to_reorder),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(24.dp)
                    )
                }
            }

            // Article info
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = item.article.title ?: "Untitled",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (isCurrentlyPlaying) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    color = if (isCurrentlyPlaying) Blue else MaterialTheme.colorScheme.onSurface
                )

                Spacer(modifier = Modifier.height(4.dp))

                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    val sourceName = item.article.siteName ?: item.article.author
                    if (sourceName != null) {
                        Text(
                            text = sourceName,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }

                    Text(
                        text = stringResource(R.string.queue_item_duration, (item.article.estimatedDuration / 60000).toInt()),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            // Remove button
            IconButton(
                onClick = onRemove,
                modifier = Modifier.size(40.dp)
            ) {
                Icon(
                    Icons.Default.Close,
                    contentDescription = stringResource(R.string.queue_remove_item),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp)
                )
            }
        }
    }
}

@Composable
private fun formatDuration(millis: Long): String {
    val minutes = (millis / 60000).toInt()
    val hours = minutes / 60
    val remainingMinutes = minutes % 60

    return when {
        hours > 0 && remainingMinutes > 0 -> stringResource(R.string.duration_hr_min, hours, remainingMinutes)
        hours > 0 -> stringResource(R.string.duration_hr, hours)
        minutes > 0 -> stringResource(R.string.duration_min, minutes)
        else -> stringResource(R.string.duration_less_than_min)
    }
}
