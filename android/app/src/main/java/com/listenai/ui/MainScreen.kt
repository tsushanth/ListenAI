package com.listenai.ui

import android.app.Activity
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.listenai.service.playback.AudioPlaybackService
import com.listenai.service.playback.AudioPlaybackStatus
import com.listenai.service.review.AppReviewService
import com.listenai.ui.components.FeedbackPromptDialog
import com.listenai.ui.navigation.BottomNavBar
import com.listenai.ui.navigation.NavGraph
import com.listenai.ui.navigation.Screen
import com.listenai.ui.playback.MiniPlayer
import org.koin.compose.koinInject

/**
 * Main screen with bottom navigation and mini player
 */
@Composable
fun MainScreen() {
    val navController = rememberNavController()
    val context = LocalContext.current
    val playbackService: AudioPlaybackService = koinInject()
    val appReviewService: AppReviewService = koinInject()

    // Observe playback state
    val playbackState by playbackService.playbackState.collectAsState()
    val currentArticle by playbackService.currentArticle.collectAsState()

    // Observe app review prompt state
    val shouldShowFeedbackPrompt by appReviewService.shouldShowFeedbackPrompt.collectAsState()

    // Get current route to determine if we should show mini player
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = navBackStackEntry?.destination?.route

    // Show mini player when:
    // 1. There's an article loaded
    // 2. Playback is active (playing or paused)
    // 3. We're NOT on the player screen
    val isOnPlayerScreen = currentRoute?.startsWith("player/") == true
    val hasActivePlayback = currentArticle != null &&
        playbackState.status in listOf(AudioPlaybackStatus.PLAYING, AudioPlaybackStatus.PAUSED)
    val showMiniPlayer = hasActivePlayback && !isOnPlayerScreen

    // Calculate time remaining
    val timeRemainingMs = if (playbackState.duration > 0) {
        ((playbackState.duration - playbackState.currentTime) * 1000).toLong()
    } else {
        0L
    }

    Scaffold(
        bottomBar = {
            Column {
                // Mini player above bottom nav
                if (showMiniPlayer) {
                    MiniPlayer(
                        title = currentArticle?.title ?: "Unknown",
                        author = currentArticle?.siteName,
                        isPlaying = playbackState.status == AudioPlaybackStatus.PLAYING,
                        progress = playbackState.progress,
                        timeRemaining = timeRemainingMs,
                        onPlayPause = { playbackService.togglePlayPause() },
                        onClose = { playbackService.stop() },
                        onClick = {
                            // Navigate to full player
                            currentArticle?.let { article ->
                                navController.navigate(Screen.Player.createRoute(article.id))
                            }
                        }
                    )
                }

                // Bottom navigation
                BottomNavBar(navController = navController)
            }
        }
    ) { paddingValues ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
        ) {
            NavGraph(navController = navController)
        }
    }

    // Feedback prompt dialog
    if (shouldShowFeedbackPrompt) {
        FeedbackPromptDialog(
            onYes = {
                // Trigger native Play Store review
                (context as? Activity)?.let { activity ->
                    appReviewService.requestPlayStoreReview(activity)
                }
            },
            onNo = {
                appReviewService.userNotEnjoying()
            },
            onDismiss = {
                appReviewService.dismissFeedbackPrompt()
            }
        )
    }
}
