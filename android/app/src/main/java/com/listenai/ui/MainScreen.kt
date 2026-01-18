package com.listenai.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.navigation.compose.rememberNavController
import com.listenai.ui.navigation.BottomNavBar
import com.listenai.ui.navigation.NavGraph
import com.listenai.ui.playback.MiniPlayer

/**
 * Main screen with bottom navigation and mini player
 */
@Composable
fun MainScreen() {
    val navController = rememberNavController()

    // TODO: Get from playback service
    var showMiniPlayer by remember { mutableStateOf(false) }

    Scaffold(
        bottomBar = {
            Column {
                // Mini player above bottom nav
                if (showMiniPlayer) {
                    MiniPlayer(
                        title = "Apple Vision Pro slashes production...",
                        author = "Tech News",
                        isPlaying = true,
                        progress = 0.3f,
                        timeRemaining = 420000L,
                        onPlayPause = { /* TODO */ },
                        onClose = { showMiniPlayer = false },
                        onClick = { /* TODO: Open full player */ }
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
}
