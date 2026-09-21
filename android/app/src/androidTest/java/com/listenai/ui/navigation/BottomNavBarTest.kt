package com.listenai.ui.navigation

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.listenai.ui.theme.ListenAITheme
import org.junit.Rule
import org.junit.Test

/**
 * Covers the restyled bottom nav: all four tabs render with their real labels,
 * and tapping a tab actually moves the NavController to that tab's route (not
 * just a visual selected state with nothing wired underneath).
 */
class BottomNavBarTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Composable
    private fun HarnessWithNavHost(onRoute: (String?) -> Unit = {}) {
        val navController = rememberNavController()
        val backStackEntry by navController.currentBackStackEntryAsState()
        onRoute(backStackEntry?.destination?.route)

        ListenAITheme {
            androidx.compose.material3.Scaffold(
                bottomBar = { BottomNavBar(navController = navController) }
            ) { padding ->
                NavHost(
                    navController = navController,
                    startDestination = Screen.Home.route,
                    modifier = androidx.compose.ui.Modifier.padding(padding)
                ) {
                    composable(Screen.Home.route) { Text("home screen content") }
                    composable(Screen.Library.route) { Text("library screen content") }
                    composable(Screen.ReadText.route) { Text("read text screen content") }
                    composable(Screen.Settings.route) { Text("settings screen content") }
                }
            }
        }
    }

    @Test
    fun allFourTabs_renderWithRealLabels() {
        composeTestRule.setContent { HarnessWithNavHost() }

        composeTestRule.onNodeWithText("Home").assertExists()
        composeTestRule.onNodeWithText("My Library").assertExists()
        composeTestRule.onNodeWithText("Read Text").assertExists()
        composeTestRule.onNodeWithText("Settings").assertExists()
    }

    @Test
    fun tappingLibraryTab_actuallyNavigatesToLibraryRoute() {
        var currentRoute: String? = null

        composeTestRule.setContent {
            HarnessWithNavHost(onRoute = { currentRoute = it })
        }

        composeTestRule.onNodeWithText("My Library").performClick()
        composeTestRule.waitForIdle()

        assert(currentRoute == Screen.Library.route) {
            "Expected route \"${Screen.Library.route}\" after tapping My Library, got \"$currentRoute\""
        }
        composeTestRule.onNodeWithText("library screen content").assertExists()
    }

    @Test
    fun tappingSettingsTab_actuallyNavigatesToSettingsRoute() {
        composeTestRule.setContent { HarnessWithNavHost() }

        composeTestRule.onNodeWithText("Settings").performClick()
        composeTestRule.waitForIdle()

        composeTestRule.onNodeWithText("settings screen content").assertExists()
    }
}
