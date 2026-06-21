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
import com.listenai.ui.read_text.ReadTextScreen
import com.listenai.ui.settings.SettingsScreen
import com.listenai.ui.subscription.SubscriptionScreen
import com.listenai.ui.queue.QueueScreen
import com.listenai.ui.usage.UsageQuotaScreen
import com.listenai.ui.voice.VoiceCloningListScreen
import com.listenai.ui.voice.VoiceCloningFlowScreen
import com.listenai.ui.voice.VoicePickerScreen
import com.listenai.ui.marketplace.VoiceMarketplaceScreen
import com.listenai.ui.marketplace.VoiceDetailScreen
import com.listenai.ui.marketplace.MySharedVoicesScreen
import com.listenai.ui.marketplace.ShareVoiceScreen
import com.listenai.ui.marketplace.RewardsScreen

/**
 * Navigation routes
 */
sealed class Screen(val route: String) {
    object Home : Screen("home")
    object Library : Screen("library")
    object ReadText : Screen("read_text")
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
    object Marketplace : Screen("marketplace")
    object MarketplaceVoiceDetail : Screen("marketplace/voice/{voiceId}") {
        fun createRoute(voiceId: String) = "marketplace/voice/$voiceId"
    }
    object MySharedVoices : Screen("my_shared_voices")
    object ShareVoice : Screen("share_voice")
    object Rewards : Screen("rewards")
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

        composable(Screen.ReadText.route) {
            ReadTextScreen()
        }

        composable(Screen.Settings.route) {
            SettingsScreen(
                onNavigateToVoices = { navController.navigate(Screen.VoicePicker.route) },
                onNavigateToUsage = { navController.navigate(Screen.Usage.route) },
                onNavigateToVoiceCloning = { navController.navigate(Screen.VoiceCloning.route) },
                onNavigateToMarketplace = { navController.navigate(Screen.Marketplace.route) },
                onNavigateToSubscription = { navController.navigate(Screen.Subscription.route) }
            )
        }

        composable(Screen.Import.route) {
            ImportScreen(
                onNavigateBack = { navController.popBackStack() },
                onImportComplete = { articleId ->
                    // Pop ImportScreen so when user goes back from Player, they return to Library
                    navController.popBackStack()
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
                    // Pop MailImportScreen so when user goes back from Player, they return to Library
                    navController.popBackStack()
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

        composable(Screen.Marketplace.route) {
            VoiceMarketplaceScreen(
                onNavigateBack = { navController.popBackStack() },
                onNavigateToVoiceDetail = { voiceId ->
                    navController.navigate(Screen.MarketplaceVoiceDetail.createRoute(voiceId))
                },
                onNavigateToMyShares = { navController.navigate(Screen.MySharedVoices.route) },
                onNavigateToRewards = { navController.navigate(Screen.Rewards.route) }
            )
        }

        composable(
            route = Screen.MarketplaceVoiceDetail.route,
            arguments = listOf(
                navArgument("voiceId") { type = NavType.StringType }
            )
        ) { backStackEntry ->
            val voiceId = backStackEntry.arguments?.getString("voiceId") ?: ""
            VoiceDetailScreen(
                voiceId = voiceId,
                onNavigateBack = { navController.popBackStack() }
            )
        }

        composable(Screen.MySharedVoices.route) {
            MySharedVoicesScreen(
                onNavigateBack = { navController.popBackStack() },
                onNavigateToShare = { navController.navigate(Screen.ShareVoice.route) }
            )
        }

        composable(Screen.ShareVoice.route) {
            ShareVoiceScreen(
                onNavigateBack = { navController.popBackStack() },
                onShareComplete = {
                    // Go back to my shares list
                    navController.popBackStack()
                }
            )
        }

        composable(Screen.Rewards.route) {
            RewardsScreen(
                onNavigateBack = { navController.popBackStack() }
            )
        }
    }
}
