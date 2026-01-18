package com.listenai.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.listenai.ui.home.HomeScreen
import com.listenai.ui.import_content.ImportScreen
import com.listenai.ui.library.LibraryScreen
import com.listenai.ui.settings.SettingsScreen

/**
 * Navigation routes
 */
sealed class Screen(val route: String) {
    object Home : Screen("home")
    object Library : Screen("library")
    object Settings : Screen("settings")
    object Player : Screen("player/{articleId}") {
        fun createRoute(articleId: String) = "player/$articleId"
    }
    object Import : Screen("import")
    object VoicePicker : Screen("voice_picker")
    object Playlist : Screen("playlist/{playlistId}") {
        fun createRoute(playlistId: String) = "playlist/$playlistId"
    }
    object Queue : Screen("queue")
    object Usage : Screen("usage")
}

/**
 * Main navigation host
 */
@Composable
fun NavGraph(
    navController: NavHostController,
    startDestination: String = Screen.Home.route
) {
    NavHost(
        navController = navController,
        startDestination = startDestination
    ) {
        composable(Screen.Home.route) {
            HomeScreen(
                onNavigateToImport = { navController.navigate(Screen.Import.route) }
            )
        }

        composable(Screen.Library.route) {
            LibraryScreen(
                onArticleClick = { articleId ->
                    navController.navigate(Screen.Player.createRoute(articleId))
                }
            )
        }

        composable(Screen.Settings.route) {
            SettingsScreen(
                onNavigateToVoices = { navController.navigate(Screen.VoicePicker.route) },
                onNavigateToUsage = { navController.navigate(Screen.Usage.route) }
            )
        }

        composable(Screen.Import.route) {
            ImportScreen(
                onNavigateBack = { navController.popBackStack() },
                onImportComplete = { articleId ->
                    navController.navigate(Screen.Player.createRoute(articleId))
                }
            )
        }

        composable(Screen.VoicePicker.route) {
            // VoicePickerScreen()
        }

        composable(Screen.Queue.route) {
            // QueueScreen()
        }

        composable(Screen.Usage.route) {
            // UsageQuotaScreen()
        }
    }
}
