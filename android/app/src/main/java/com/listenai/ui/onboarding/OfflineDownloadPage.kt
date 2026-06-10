package com.listenai.ui.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.listenai.service.settings.SettingsManager
import com.listenai.service.tts.KokoroModelDownloader

/**
 * Onboarding step: "Use Kokoro offline too?"
 *
 * Conditional — only shown when the user picked on-device Kokoro on the
 * previous picker. Selecting "Download now" sets the model download in
 * motion (background, resumable) and advances. Selecting "Maybe later"
 * leaves `useOfflineKokoro = true` but defers the download; the runtime
 * dispatcher falls back to cloud Kokoro until the model is present.
 */
@Composable
fun OfflineDownloadPage(onContinue: () -> Unit) {
    val context = LocalContext.current
    val settings = remember { SettingsManager.getInstance(context) }
    val allowCellular by settings.allowCellularModelDownload.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(24.dp))

        // Icon
        Box(
            modifier = Modifier
                .size(120.dp)
                .clip(CircleShape)
                .background(
                    Brush.linearGradient(
                        listOf(
                            Color(0xFF14B8A6).copy(alpha = 0.15f),
                            Color(0xFF3B82F6).copy(alpha = 0.15f),
                        )
                    )
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Filled.PhoneAndroid,
                contentDescription = null,
                tint = Color(0xFF14B8A6),
                modifier = Modifier.size(52.dp),
            )
        }

        Spacer(Modifier.height(20.dp))
        Text(
            text = "Use Kokoro offline too?",
            fontSize = 26.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(10.dp))
        Text(
            text = "Same voice — but generated entirely on your phone. Faster playback, works without internet, and your text never leaves your device.",
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(22.dp))

        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Bullet(Icons.Filled.Bolt, Color(0xFFEAB308), "Instant — no waiting in queue")
            Bullet(Icons.Filled.WifiOff, Color(0xFF3B82F6), "Works offline once downloaded")
            Bullet(Icons.Filled.Lock, Color(0xFF22C55E), "Your text never leaves your phone")
            Bullet(
                Icons.Filled.Storage,
                Color(0xFF6B7280),
                "One-time download, about ${KokoroModelDownloader.estimatedSizeMB} MB",
            )
        }

        Spacer(Modifier.height(18.dp))

        // Honest expectation note — same as iOS.
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(10.dp))
                .background(Color(0xFFEA580C).copy(alpha = 0.08f))
                .border(1.dp, Color(0xFFEA580C).copy(alpha = 0.25f), RoundedCornerShape(10.dp))
                .padding(12.dp),
        ) {
            Icon(
                imageVector = Icons.Filled.Info,
                contentDescription = null,
                tint = Color(0xFFEA580C),
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(10.dp))
            Column {
                Text(
                    text = "Slightly less polished than cloud",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = "On-device synthesis sounds close to cloud but you may hear minor differences in pronunciation of unusual words. You can switch back to cloud in Settings.",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Spacer(Modifier.height(14.dp))

        // Cellular toggle
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surfaceContainer)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = Icons.Filled.NetworkCell,
                contentDescription = null,
                tint = Color(0xFFEA580C),
                modifier = Modifier.size(24.dp).padding(top = 2.dp),
            )
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "Allow cellular download",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    "Off by default — saves data plan. We'll wait for WiFi.",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = allowCellular,
                onCheckedChange = { settings.setAllowCellularModelDownload(it) },
            )
        }

        Spacer(Modifier.height(20.dp))

        Button(
            onClick = {
                // Kick off the download. Service decides whether to proceed
                // now (WiFi or cellular allowed) or queue until WiFi.
                KokoroModelDownloader.getInstance(context).startIfPossible()
                onContinue()
            },
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp),
            shape = RoundedCornerShape(12.dp),
        ) {
            Text("Download now", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        }

        Spacer(Modifier.height(8.dp))

        TextButton(
            onClick = {
                // Skip download — runtime still uses cloud until model arrives.
                onContinue()
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                "Maybe later — use cloud for now",
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun Bullet(icon: ImageVector, color: Color, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.width(12.dp))
        Text(text, fontSize = 14.sp)
    }
}
