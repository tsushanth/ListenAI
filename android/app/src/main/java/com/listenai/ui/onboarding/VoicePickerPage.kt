package com.listenai.ui.onboarding

import android.media.MediaPlayer
import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.listenai.R
import com.listenai.service.settings.SettingsManager

/**
 * Onboarding step: "Choose your voice."
 *
 * Mirrors the iOS picker. On Android both options use Kokoro under the
 * hood, so the choice is purely about **where it runs** (and the
 * trade-offs that come with it) — not about a different voice character.
 *
 *   - Premium voice (Cloud) → existing Fly `listenai-tts-worker`,
 *     no download, but needs internet and queues briefly.
 *   - On-device voice (Kokoro on this phone) → ~80 MB ONNX model
 *     download, then synthesizes locally, works offline.
 *
 * Both Play buttons render the **same** bundled Kokoro sample
 * (`R.raw.kokoro_sample`) — that's honest, because on-device Kokoro
 * sounds essentially identical to cloud Kokoro on real hardware. The
 * picker is the user's infra choice, not a quality choice.
 *
 * Selection writes [SettingsManager.useOfflineKokoro]. If `true`, the
 * next page (`OfflineDownloadPage`) offers the model download; if
 * `false`, that page is skipped.
 */
@Composable
fun VoicePickerPage() {
    val context = LocalContext.current
    val settings = remember { SettingsManager.getInstance(context) }
    val useOfflineKokoro by settings.useOfflineKokoro.collectAsState()

    LaunchedEffect(Unit) {
        Log.i("VoicePickerPage", "shown — current useOfflineKokoro=$useOfflineKokoro")
    }

    // One MediaPlayer per page, paused/released on dispose.
    val mediaPlayer = remember { mutableStateOf<MediaPlayer?>(null) }
    var currentlyPlaying by remember { mutableStateOf<String?>(null) }

    DisposableEffect(Unit) {
        onDispose {
            mediaPlayer.value?.release()
            mediaPlayer.value = null
        }
    }

    fun playSample(id: String) {
        // Single-shot: tearing down whatever was playing, start fresh.
        mediaPlayer.value?.release()
        mediaPlayer.value = null
        currentlyPlaying = null

        val mp = MediaPlayer.create(context, R.raw.kokoro_sample)
        if (mp != null) {
            mp.setOnCompletionListener {
                it.release()
                if (mediaPlayer.value === it) {
                    mediaPlayer.value = null
                    currentlyPlaying = null
                }
            }
            mp.start()
            mediaPlayer.value = mp
            currentlyPlaying = id
        }
    }

    fun stopSample() {
        mediaPlayer.value?.release()
        mediaPlayer.value = null
        currentlyPlaying = null
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Spacer(modifier = Modifier.height(24.dp))

        // Icon
        Box(
            modifier = Modifier
                .size(120.dp)
                .clip(CircleShape)
                .background(
                    Brush.linearGradient(
                        colors = listOf(
                            Color(0xFF7B5BFF).copy(alpha = 0.15f),
                            Color(0xFF3B82F6).copy(alpha = 0.15f),
                        )
                    )
                ),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Filled.PlayArrow,
                contentDescription = null,
                tint = Color(0xFF7B5BFF),
                modifier = Modifier.size(52.dp)
            )
        }

        Spacer(modifier = Modifier.height(20.dp))

        Text(
            text = "Choose your voice",
            fontSize = 26.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
        )

        Spacer(modifier = Modifier.height(10.dp))

        Text(
            text = "Same Kokoro voice in both options — pick where it runs. You can change this any time in Settings.",
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        Spacer(modifier = Modifier.height(24.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            VoiceSampleCard(
                modifier = Modifier.weight(1f),
                title = "Premium voice",
                subtitle = "Cloud · highest quality · needs internet",
                tint = Color(0xFF7B5BFF),
                isSelected = !useOfflineKokoro,
                isPlaying = currentlyPlaying == "cloud",
                onSelect = {
                    Log.i("VoicePickerPage", "user picked Cloud (Premium)")
                    settings.setUseOfflineKokoro(false)
                },
                onTogglePlay = {
                    if (currentlyPlaying == "cloud") stopSample() else playSample("cloud")
                },
            )
            VoiceSampleCard(
                modifier = Modifier.weight(1f),
                title = "On-device",
                subtitle = "~80 MB download · offline · private",
                tint = Color(0xFF22C55E),
                isSelected = useOfflineKokoro,
                isPlaying = currentlyPlaying == "ondevice",
                onSelect = {
                    Log.i("VoicePickerPage", "user picked On-device (Kokoro)")
                    settings.setUseOfflineKokoro(true)
                },
                onTogglePlay = {
                    if (currentlyPlaying == "ondevice") stopSample() else playSample("ondevice")
                },
            )
        }

        Spacer(modifier = Modifier.height(20.dp))
    }
}

@Composable
private fun VoiceSampleCard(
    modifier: Modifier = Modifier,
    title: String,
    subtitle: String,
    tint: Color,
    isSelected: Boolean,
    isPlaying: Boolean,
    onSelect: () -> Unit,
    onTogglePlay: () -> Unit,
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .border(
                width = if (isSelected) 2.dp else 0.dp,
                color = if (isSelected) tint else Color.Transparent,
                shape = RoundedCornerShape(12.dp),
            )
            .clickable { onSelect() }
            .padding(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = title,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            Icon(
                imageVector = if (isSelected) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
                contentDescription = null,
                tint = if (isSelected) tint else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
                modifier = Modifier.size(20.dp),
            )
        }

        Spacer(modifier = Modifier.height(6.dp))

        Text(
            text = subtitle,
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2,
        )

        Spacer(modifier = Modifier.height(10.dp))

        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(16.dp))
                .background(tint)
                .clickable { onTogglePlay() }
                .padding(horizontal = 12.dp, vertical = 6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = if (isPlaying) Icons.Filled.Stop else Icons.Filled.PlayArrow,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(modifier = Modifier.width(4.dp))
                Text(
                    text = if (isPlaying) "Stop" else "Play sample",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Color.White,
                )
            }
        }
    }
}
