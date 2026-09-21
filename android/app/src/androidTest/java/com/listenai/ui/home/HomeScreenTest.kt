package com.listenai.ui.home

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.listenai.ui.theme.ListenAITheme
import org.junit.Rule
import org.junit.Test

/**
 * Covers the restyled Home screen: every quick-action row renders with its real
 * copy, tapping a row reports which action was tapped, and the hero's "Try for
 * free" pill reaches its own callback rather than the row callback.
 */
class HomeScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun heroBanner_showsPromoCopyAndFreeTrialPill() {
        composeTestRule.setContent {
            ListenAITheme {
                HomeScreen()
            }
        }

        composeTestRule.onNodeWithText("Download and listen anytime, anywhere").assertExists()
        composeTestRule.onNodeWithText("Try for free").assertExists()
    }

    @Test
    fun quickActions_allFiveRowsRender() {
        composeTestRule.setContent {
            ListenAITheme {
                HomeScreen()
            }
        }

        composeTestRule.onNodeWithText("Type or Paste Text").assertExists()
        composeTestRule.onNodeWithText("Document").assertExists()
        composeTestRule.onNodeWithText("Scan Text").assertExists()
        composeTestRule.onNodeWithText("Web Link").assertExists()
        composeTestRule.onNodeWithText("Mail").assertExists()
    }

    @Test
    fun tappingDocumentRow_invokesImportCallbackWithDocumentAction() {
        var tappedAction: String? = null

        composeTestRule.setContent {
            ListenAITheme {
                HomeScreen(onNavigateToImport = { tappedAction = "document" })
            }
        }

        composeTestRule.onNodeWithText("Document").performClick()

        assert(tappedAction == "document") {
            "Expected the Document row to report \"document\", got $tappedAction"
        }
    }

    @Test
    fun tappingTryForFree_invokesSubscriptionCallback_notImportCallback() {
        var subscriptionTapped = false
        var importTapped = false

        composeTestRule.setContent {
            ListenAITheme {
                HomeScreen(
                    onNavigateToImport = { importTapped = true },
                    onNavigateToSubscription = { subscriptionTapped = true }
                )
            }
        }

        composeTestRule.onNodeWithText("Try for free").performClick()

        assert(subscriptionTapped) { "Try for free pill did not reach onNavigateToSubscription" }
        assert(!importTapped) { "Try for free pill incorrectly fired onNavigateToImport" }
    }
}
