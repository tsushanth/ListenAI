package com.listenai.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import com.listenai.ui.home.HomeScreen
import com.listenai.ui.import_content.ImportScreen
import com.listenai.ui.import_content.MailImportScreen
import com.listenai.ui.library.LibraryScreen
import com.listenai.ui.playback.PlayerScreen
import com.listenai.ui.settings.SettingsScreen
import com.listenai.ui.subscription.SubscriptionScreen
import com.listenai.ui.queue.QueueScreen
import com.listenai.ui.usage.UsageQuotaScreen
import com.listenai.ui.voice.VoiceCloningListScreen
import com.listenai.ui.voice.VoiceCloningFlowScreen
import com.listenai.ui.voice.VoicePickerScreen

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
    object MailImport : Screen("mail_import")
    object VoicePicker : Screen("voice_picker")
    object Playlist : Screen("playlist/{playlistId}") {
        fun createRoute(playlistId: String) = "playlist/$playlistId"
    }
    object Queue : Screen("queue")
    object Usage : Screen("usage")
    object Subscription : Screen("subscription")
    object VoiceCloning : Screen("voice_cloning")
    object VoiceCloningFlow : Screen("voice_cloning_flow")
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
                onNavigateToImport = { navController.navigate(Screen.Import.route) },
                onNavigateToSubscription = { navController.navigate(Screen.Subscription.route) }
            )
        }

        composable(Screen.Library.route) {
            LibraryScreen(
                onArticleClick = { articleId ->
                    navController.navigate(Screen.Player.createRoute(articleId))
                },
                onAddContent = {
                    navController.navigate(Screen.Import.route)
                }
            )
        }

        composable(Screen.Settings.route) {
            SettingsScreen(
                onNavigateToVoices = { navController.navigate(Screen.VoicePicker.route) },
                onNavigateToUsage = { navController.navigate(Screen.Usage.route) },
                onNavigateToVoiceCloning = { navController.navigate(Screen.VoiceCloning.route) }
            )
        }

        composable(Screen.Import.route) {
            ImportScreen(
                onNavigateBack = { navController.popBackStack() },
                onImportComplete = { articleId ->
                    navController.navigate(Screen.Player.createRoute(articleId))
                },
                onNavigateToEmail = {
                    navController.navigate(Screen.MailImport.route)
                }
            )
        }

        composable(Screen.MailImport.route) {
            MailImportScreen(
                onNavigateBack = { navController.popBackStack() },
                onImportComplete = { articleId ->
                    navController.navigate(Screen.Player.createRoute(articleId))
                }
            )
        }

        composable(Screen.VoicePicker.route) {
            VoicePickerScreen(
                onNavigateBack = { navController.popBackStack() }
            )
        }

        composable(Screen.Queue.route) {
            QueueScreen(
                onNavigateBack = { navController.popBackStack() },
                onPlayItem = { articleId ->
                    navController.navigate(Screen.Player.createRoute(articleId))
                }
            )
        }

        composable(Screen.Usage.route) {
            UsageQuotaScreen(
                onNavigateBack = { navController.popBackStack() },
                onUpgrade = { navController.navigate(Screen.Subscription.route) }
            )
        }

        composable(
            route = Screen.Player.route,
            arguments = listOf(
                navArgument("articleId") { type = NavType.StringType }
            )
        ) { backStackEntry ->
            val articleId = backStackEntry.arguments?.getString("articleId") ?: ""
            PlayerScreen(
                articleId = articleId,
                onNavigateBack = { navController.popBackStack() },
                onUpgrade = { navController.navigate(Screen.Subscription.route) },
                onNavigateToVoiceCloning = { navController.navigate(Screen.VoiceCloning.route) }
            )
        }

        composable(Screen.Subscription.route) {
            SubscriptionScreen(
                onNavigateBack = { navController.popBackStack() }
            )
        }

        composable(Screen.VoiceCloning.route) {
            VoiceCloningListScreen(
                onNavigateBack = { navController.popBackStack() },
                onNavigateToCloneFlow = { navController.navigate(Screen.VoiceCloningFlow.route) }
            )
        }

        composable(Screen.VoiceCloningFlow.route) {
            VoiceCloningFlowScreen(
                onComplete = {
                    // Pop back to the list screen which will refresh
                    navController.popBackStack()
                },
                onCancel = { navController.popBackStack() }
            )
        }
    }
}
