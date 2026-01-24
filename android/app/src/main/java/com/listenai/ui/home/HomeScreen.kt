package com.listenai.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.listenai.R
import com.listenai.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    onNavigateToImport: () -> Unit = {},
    onNavigateToSubscription: () -> Unit = {}
) {
    val scrollState = rememberScrollState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { },
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
                .verticalScroll(scrollState)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            // Promotional Banner
            PromoBanner(onNavigateToSubscription = onNavigateToSubscription)

            // Quick Actions Section
            QuickActionsSection(onActionClick = { onNavigateToImport() })
        }
    }
}

@Composable
private fun PromoBanner(onNavigateToSubscription: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Icon
            Box(
                modifier = Modifier
                    .size(80.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Green.copy(alpha = 0.2f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = Icons.Default.Headphones,
                    contentDescription = null,
                    modifier = Modifier.size(40.dp),
                    tint = Green
                )
            }

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(
                    text = stringResource(R.string.promo_title),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium
                )

                TextButton(
                    onClick = onNavigateToSubscription,
                    contentPadding = PaddingValues(0.dp)
                ) {
                    Text(
                        text = stringResource(R.string.promo_button),
                        style = MaterialTheme.typography.labelMedium
                    )
                }
            }
        }
    }
}

@Composable
private fun QuickActionsSection(
    onActionClick: (String) -> Unit
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text(
            text = stringResource(R.string.quick_actions_title),
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 4.dp)
        )

        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceVariant
            )
        ) {
            Column {
                QuickActionRow(
                    icon = Icons.Default.Description,
                    iconColor = Blue,
                    title = stringResource(R.string.action_document),
                    subtitle = stringResource(R.string.action_document_subtitle),
                    onClick = { onActionClick("document") }
                )

                Divider(modifier = Modifier.padding(start = 72.dp))

                QuickActionRow(
                    icon = Icons.Default.DocumentScanner,
                    iconColor = Purple,
                    title = stringResource(R.string.action_scan),
                    subtitle = stringResource(R.string.action_scan_subtitle),
                    onClick = { onActionClick("scan") }
                )

                Divider(modifier = Modifier.padding(start = 72.dp))

                QuickActionRow(
                    icon = Icons.Default.Link,
                    iconColor = Orange,
                    title = stringResource(R.string.action_web_link),
                    subtitle = stringResource(R.string.action_web_link_subtitle),
                    onClick = { onActionClick("url") }
                )

                Divider(modifier = Modifier.padding(start = 72.dp))

                QuickActionRow(
                    icon = Icons.Default.EditNote,
                    iconColor = Green,
                    title = stringResource(R.string.action_text),
                    subtitle = stringResource(R.string.action_text_subtitle),
                    onClick = { onActionClick("text") }
                )

                Divider(modifier = Modifier.padding(start = 72.dp))

                QuickActionRow(
                    icon = Icons.Default.Email,
                    iconColor = Red,
                    title = stringResource(R.string.action_mail),
                    subtitle = stringResource(R.string.action_mail_subtitle),
                    onClick = { onActionClick("mail") }
                )
            }
        }
    }
}

@Composable
private fun QuickActionRow(
    icon: ImageVector,
    iconColor: Color,
    title: String,
    subtitle: String,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Icon with colored background
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(iconColor.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = iconColor,
                modifier = Modifier.size(24.dp)
            )
        }

        // Text
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
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
