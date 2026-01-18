package com.listenai.ui.library

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.listenai.R
import com.listenai.data.models.Article
import com.listenai.data.models.SourceType
import com.listenai.ui.theme.*
import java.util.Date

enum class LibraryFilter {
    ALL, IN_PROGRESS, FAVORITES, ARCHIVED
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(
    onArticleClick: (String) -> Unit = {}
) {
    var selectedFilter by remember { mutableStateOf(LibraryFilter.ALL) }

    // Sample data - in real app would come from ViewModel
    val articles = remember {
        listOf(
            Article(
                id = "1",
                title = "Understanding Machine Learning Fundamentals",
                author = "Tech Insights",
                siteName = "techinsights.com",
                publishDate = Date(),
                rawText = "Machine learning is a subset of artificial intelligence...",
                wordCount = 1500,
                language = "en",
                heroImageUrl = null,
                sourceType = SourceType.WEB,
                sourceUrl = "https://example.com/ml-fundamentals",
                sourceFileName = null,
                audioFileUrl = null,
                selectedVoiceId = null,
                listenedDuration = 180000,
                totalDuration = 600000
            ),
            Article(
                id = "2",
                title = "The Future of Renewable Energy",
                author = "Green Planet",
                siteName = null,
                publishDate = null,
                rawText = "Renewable energy sources are becoming increasingly important...",
                wordCount = 2000,
                language = "en",
                heroImageUrl = null,
                sourceType = SourceType.PDF,
                sourceUrl = null,
                sourceFileName = "renewable_energy.pdf",
                audioFileUrl = null,
                selectedVoiceId = null,
                listenedDuration = 0,
                totalDuration = 900000
            ),
            Article(
                id = "3",
                title = "Introduction to Quantum Computing",
                author = "Science Daily",
                siteName = "sciencedaily.com",
                publishDate = Date(),
                rawText = "Quantum computing represents a fundamental shift...",
                wordCount = 1000,
                language = "en",
                heroImageUrl = null,
                sourceType = SourceType.WEB,
                sourceUrl = "https://example.com/quantum",
                sourceFileName = null,
                audioFileUrl = "/path/to/audio.mp3",
                selectedVoiceId = "alloy",
                isFavorite = true,
                listenedDuration = 450000,
                totalDuration = 450000,
                isCompleted = true
            )
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = stringResource(R.string.library_title),
                            fontWeight = FontWeight.Bold
                        )

                        // AI Badge
                        AIBadge()

                        // Counter Badge
                        CounterBadge(count = articles.size)
                    }
                },
                actions = {
                    ProBadge()
                }
            )
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
        ) {
            // Filter Chips
            FilterChipsRow(
                selectedFilter = selectedFilter,
                onFilterSelected = { selectedFilter = it }
            )

            // Articles List
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                items(articles) { article ->
                    ArticleCard(
                        article = article,
                        onClick = { onArticleClick(article.id) }
                    )
                }
            }
        }
    }
}

@Composable
private fun AIBadge() {
    Surface(
        shape = RoundedCornerShape(6.dp),
        color = MaterialTheme.colorScheme.surfaceVariant
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Default.AutoAwesome,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = Blue
            )
            Text(
                text = "AI",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium
            )
        }
    }
}

@Composable
private fun CounterBadge(count: Int) {
    Surface(
        shape = RoundedCornerShape(6.dp),
        color = MaterialTheme.colorScheme.surfaceVariant
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "✦",
                style = MaterialTheme.typography.labelSmall,
                color = Purple
            )
            Text(
                text = count.toString(),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium
            )
        }
    }
}

@Composable
private fun ProBadge() {
    Surface(
        shape = CircleShape,
        color = Green.copy(alpha = 0.9f)
    ) {
        Text(
            text = stringResource(R.string.pro),
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color = Color.White
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FilterChipsRow(
    selectedFilter: LibraryFilter,
    onFilterSelected: (LibraryFilter) -> Unit
) {
    LazyRow(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        item {
            FilterChip(
                selected = selectedFilter == LibraryFilter.ALL,
                onClick = { onFilterSelected(LibraryFilter.ALL) },
                label = { Text(stringResource(R.string.filter_all)) }
            )
        }
        item {
            FilterChip(
                selected = selectedFilter == LibraryFilter.IN_PROGRESS,
                onClick = { onFilterSelected(LibraryFilter.IN_PROGRESS) },
                label = { Text(stringResource(R.string.filter_in_progress)) }
            )
        }
        item {
            FilterChip(
                selected = selectedFilter == LibraryFilter.FAVORITES,
                onClick = { onFilterSelected(LibraryFilter.FAVORITES) },
                label = { Text(stringResource(R.string.filter_favorites)) }
            )
        }
        item {
            FilterChip(
                selected = selectedFilter == LibraryFilter.ARCHIVED,
                onClick = { onFilterSelected(LibraryFilter.ARCHIVED) },
                label = { Text(stringResource(R.string.filter_archived)) }
            )
        }
    }

    Spacer(modifier = Modifier.height(8.dp))
}

@Composable
private fun ArticleCard(
    article: Article,
    onClick: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            // Source Type Icon
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(getSourceTypeColor(article.sourceType).copy(alpha = 0.15f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = getSourceTypeIcon(article.sourceType),
                    contentDescription = null,
                    tint = getSourceTypeColor(article.sourceType),
                    modifier = Modifier.size(24.dp)
                )
            }

            // Content
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                // Title with dots prefix
                Row(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "···",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        text = article.displayTitle,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }

                // Author/Source
                Text(
                    text = article.displayAuthor,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )

                // Progress indicator
                if (article.totalDuration > 0) {
                    val progress = article.listenedDuration.toFloat() / article.totalDuration
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        LinearProgressIndicator(
                            progress = progress,
                            modifier = Modifier
                                .weight(1f)
                                .height(4.dp)
                                .clip(RoundedCornerShape(2.dp)),
                            color = if (article.isCompleted) Green else Blue
                        )
                        Text(
                            text = formatDuration(article.totalDuration - article.listenedDuration),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            // Menu button
            IconButton(
                onClick = { /* Show menu */ },
                modifier = Modifier.size(32.dp)
            ) {
                Icon(
                    imageVector = Icons.Default.MoreVert,
                    contentDescription = stringResource(R.string.more_options),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

private fun getSourceTypeIcon(sourceType: SourceType) = when (sourceType) {
    SourceType.WEB -> Icons.Default.Language
    SourceType.PDF -> Icons.Default.PictureAsPdf
    SourceType.CLIPBOARD -> Icons.Default.ContentPaste
    SourceType.FILE -> Icons.Default.Folder
    SourceType.MANUAL -> Icons.Default.EditNote
}

private fun getSourceTypeColor(sourceType: SourceType) = when (sourceType) {
    SourceType.WEB -> Orange
    SourceType.PDF -> Red
    SourceType.CLIPBOARD -> Purple
    SourceType.FILE -> Blue
    SourceType.MANUAL -> Green
}

private fun formatDuration(millis: Long): String {
    val totalSeconds = millis / 1000
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return if (minutes > 0) {
        "${minutes}m ${seconds}s left"
    } else {
        "${seconds}s left"
    }
}
