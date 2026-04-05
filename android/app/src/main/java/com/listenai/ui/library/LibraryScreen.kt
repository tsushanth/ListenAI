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
import org.koin.androidx.compose.koinViewModel

enum class LibraryFilter {
    ALL, IN_PROGRESS, FAVORITES, EMAIL, ARCHIVED
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(
    viewModel: LibraryViewModel = koinViewModel(),
    onArticleClick: (String) -> Unit = {},
    onAddContent: () -> Unit = {}
) {
    val articles by viewModel.articles.collectAsState()
    val articleCount by viewModel.articleCount.collectAsState()
    val selectedFilter by viewModel.selectedFilter.collectAsState()

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
                        CounterBadge(count = articleCount)
                    }
                },
                actions = {
                    ProBadge()
                }
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = onAddContent,
                containerColor = Blue,
                contentColor = Color.White,
                modifier = Modifier.padding(16.dp)
            ) {
                Icon(
                    imageVector = Icons.Default.Add,
                    contentDescription = "Add content"
                )
            }
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
                onFilterSelected = { viewModel.setFilter(it) }
            )

            // Articles List or Empty State
            if (articles.isEmpty()) {
                EmptyLibraryState(
                    selectedFilter = selectedFilter,
                    onAddContent = onAddContent
                )
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 88.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    items(articles, key = { it.id }) { article ->
                        ArticleCard(
                            article = article,
                            onClick = { onArticleClick(article.id) },
                            onFavorite = { viewModel.toggleFavorite(article) },
                            onArchive = { viewModel.toggleArchive(article) },
                            onDelete = { viewModel.deleteArticle(article) }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyLibraryState(
    selectedFilter: LibraryFilter,
    onAddContent: () -> Unit = {}
) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.padding(32.dp)
        ) {
            val (icon, title, description) = when (selectedFilter) {
                LibraryFilter.ALL -> Triple(
                    Icons.Default.Article,
                    stringResource(R.string.empty_library),
                    stringResource(R.string.empty_library_description)
                )
                LibraryFilter.IN_PROGRESS -> Triple(
                    Icons.Default.PlayCircle,
                    stringResource(R.string.library_empty_in_progress_title),
                    stringResource(R.string.library_empty_in_progress_description)
                )
                LibraryFilter.FAVORITES -> Triple(
                    Icons.Default.Favorite,
                    stringResource(R.string.library_empty_favorites_title),
                    stringResource(R.string.library_empty_favorites_description)
                )
                LibraryFilter.EMAIL -> Triple(
                    Icons.Default.Email,
                    stringResource(R.string.library_empty_email_title),
                    stringResource(R.string.library_empty_email_description)
                )
                LibraryFilter.ARCHIVED -> Triple(
                    Icons.Default.Archive,
                    stringResource(R.string.library_empty_archived_title),
                    stringResource(R.string.library_empty_archived_description)
                )
            }

            Icon(
                imageVector = icon,
                contentDescription = null,
                modifier = Modifier.size(64.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
            )

            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Text(
                text = description,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center
            )

            // Add Content button (only for ALL filter)
            if (selectedFilter == LibraryFilter.ALL) {
                Spacer(modifier = Modifier.height(8.dp))
                Button(
                    onClick = onAddContent,
                    colors = ButtonDefaults.buttonColors(containerColor = Blue)
                ) {
                    Icon(
                        imageVector = Icons.Default.Add,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(stringResource(R.string.library_add_content_button))
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
                selected = selectedFilter == LibraryFilter.EMAIL,
                onClick = { onFilterSelected(LibraryFilter.EMAIL) },
                label = { Text(stringResource(R.string.filter_email)) },
                leadingIcon = if (selectedFilter == LibraryFilter.EMAIL) {
                    { Icon(Icons.Default.Email, contentDescription = null, modifier = Modifier.size(18.dp)) }
                } else null
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
    onClick: () -> Unit,
    onFavorite: () -> Unit,
    onArchive: () -> Unit,
    onDelete: () -> Unit
) {
    var showMenu by remember { mutableStateOf(false) }

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
                // Title with dots prefix and favorite indicator
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
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f)
                    )
                    if (article.isFavorite) {
                        Icon(
                            imageVector = Icons.Default.Favorite,
                            contentDescription = "Favorite",
                            modifier = Modifier.size(16.dp),
                            tint = Red
                        )
                    }
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
                            progress = { progress },
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

            // Menu button with dropdown
            Box {
                IconButton(
                    onClick = { showMenu = true },
                    modifier = Modifier.size(32.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.MoreVert,
                        contentDescription = stringResource(R.string.more_options),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                DropdownMenu(
                    expanded = showMenu,
                    onDismissRequest = { showMenu = false }
                ) {
                    DropdownMenuItem(
                        text = {
                            Text(if (article.isFavorite) stringResource(R.string.remove_from_favorites) else stringResource(R.string.add_to_favorites))
                        },
                        onClick = {
                            onFavorite()
                            showMenu = false
                        },
                        leadingIcon = {
                            Icon(
                                imageVector = if (article.isFavorite) Icons.Default.HeartBroken else Icons.Default.Favorite,
                                contentDescription = null
                            )
                        }
                    )
                    DropdownMenuItem(
                        text = {
                            Text(if (article.isArchived) stringResource(R.string.unarchive) else stringResource(R.string.archive))
                        },
                        onClick = {
                            onArchive()
                            showMenu = false
                        },
                        leadingIcon = {
                            Icon(
                                imageVector = if (article.isArchived) Icons.Default.Unarchive else Icons.Default.Archive,
                                contentDescription = null
                            )
                        }
                    )
                    Divider()
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.delete)) },
                        onClick = {
                            onDelete()
                            showMenu = false
                        },
                        leadingIcon = {
                            Icon(
                                imageVector = Icons.Default.Delete,
                                contentDescription = null,
                                tint = Red
                            )
                        }
                    )
                }
            }
        }
    }
}

private fun getSourceTypeIcon(sourceType: SourceType) = when (sourceType) {
    SourceType.WEB -> Icons.Default.Language
    SourceType.PDF -> Icons.Default.PictureAsPdf
    SourceType.EPUB -> Icons.Default.Book
    SourceType.CLIPBOARD -> Icons.Default.ContentPaste
    SourceType.FILE -> Icons.Default.Folder
    SourceType.MANUAL -> Icons.Default.EditNote
    SourceType.EMAIL -> Icons.Default.Email
}

private fun getSourceTypeColor(sourceType: SourceType) = when (sourceType) {
    SourceType.WEB -> Orange
    SourceType.PDF -> Red
    SourceType.EPUB -> Blue
    SourceType.CLIPBOARD -> Purple
    SourceType.FILE -> Blue
    SourceType.MANUAL -> Green
    SourceType.EMAIL -> Coral
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
