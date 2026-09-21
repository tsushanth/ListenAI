package com.listenai.ui.home

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
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

    // MainScreen already wraps every screen in a Scaffold that reserves the top
    // system-bar inset, so this deliberately doesn't nest a second Scaffold here —
    // that double-reserved the top inset and pushed the hero down by roughly twice
    // the status bar's height.
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BackgroundLight)
            .verticalScroll(scrollState)
    ) {
        HeroBanner(onNavigateToSubscription = onNavigateToSubscription)

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            QuickActionsSection(onActionClick = { onNavigateToImport() })
        }
    }
}

/**
 * The hero moment: a warm diagonal wash carrying a small icon cluster (mic +
 * waveform, echoing "type it, hear it") and the one thing we want said here —
 * everything below stays quiet white so this is what people remember.
 */
@Composable
private fun HeroBanner(onNavigateToSubscription: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(bottomStart = 28.dp, bottomEnd = 28.dp))
            .background(
                Brush.linearGradient(
                    colors = listOf(ListenHeroPink, ListenHeroLavender)
                )
            )
            .padding(horizontal = 20.dp)
            .padding(top = 8.dp, bottom = 24.dp)
    ) {
        Column {
            Spacer(Modifier.height(24.dp))

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(140.dp),
                contentAlignment = Alignment.Center
            ) {
                HeroGlyphCluster()
            }

            Spacer(Modifier.height(20.dp))

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    text = stringResource(R.string.promo_title),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = ListenInk,
                    modifier = Modifier
                        .weight(1f)
                        .padding(end = 12.dp)
                )

                Surface(
                    shape = CircleShape,
                    color = Color.White,
                    onClick = onNavigateToSubscription
                ) {
                    Text(
                        text = stringResource(R.string.promo_button),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = ListenInk,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun HeroGlyphCluster() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy((-12).dp)
    ) {
        HeroGlyphTile(icon = Icons.Filled.GraphicEq, rotationDeg = -8f)
        HeroGlyphTile(icon = Icons.Filled.Mic, size = 92.dp, rotationDeg = 0f, elevated = true)
        HeroGlyphTile(icon = Icons.Filled.Headphones, rotationDeg = 8f)
    }
}

@Composable
private fun HeroGlyphTile(
    icon: ImageVector,
    size: Dp = 68.dp,
    rotationDeg: Float,
    elevated: Boolean = false
) {
    Surface(
        modifier = Modifier
            .size(size)
            .rotate(rotationDeg),
        shape = RoundedCornerShape(20.dp),
        color = Color.White,
        shadowElevation = if (elevated) 8.dp else 2.dp
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = ListenAmber,
                modifier = Modifier.size(size / 2.2f)
            )
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
            color = ListenInk,
            modifier = Modifier.padding(horizontal = 4.dp)
        )

        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(20.dp),
            color = Color.White,
            border = BorderStroke(1.dp, ListenCardBorder)
        ) {
            Column {
                QuickActionRow(
                    icon = Icons.Default.TextFields,
                    title = stringResource(R.string.action_text),
                    subtitle = stringResource(R.string.action_text_subtitle),
                    onClick = { onActionClick("text") }
                )

                Divider(color = ListenCardBorder, modifier = Modifier.padding(start = 76.dp))

                QuickActionRow(
                    icon = Icons.Default.Description,
                    title = stringResource(R.string.action_document),
                    subtitle = stringResource(R.string.action_document_subtitle),
                    onClick = { onActionClick("document") }
                )

                Divider(color = ListenCardBorder, modifier = Modifier.padding(start = 76.dp))

                QuickActionRow(
                    icon = Icons.Default.DocumentScanner,
                    title = stringResource(R.string.action_scan),
                    subtitle = stringResource(R.string.action_scan_subtitle),
                    onClick = { onActionClick("scan") }
                )

                Divider(color = ListenCardBorder, modifier = Modifier.padding(start = 76.dp))

                QuickActionRow(
                    icon = Icons.Default.Link,
                    title = stringResource(R.string.action_web_link),
                    subtitle = stringResource(R.string.action_web_link_subtitle),
                    onClick = { onActionClick("url") }
                )

                Divider(color = ListenCardBorder, modifier = Modifier.padding(start = 76.dp))

                QuickActionRow(
                    icon = Icons.Default.Email,
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
    title: String,
    subtitle: String,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // One unified cream-and-amber tile language for every row, matching the
        // reference's single icon identity instead of a color per feature.
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(ListenCreamTile),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = ListenAmber,
                modifier = Modifier.size(24.dp)
            )
        }

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Bold,
                color = ListenInk
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = ListenInkSecondary
            )
        }
    }
}
