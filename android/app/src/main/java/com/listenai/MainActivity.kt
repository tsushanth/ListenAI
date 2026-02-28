package com.listenai

import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.lifecycleScope
import com.listenai.service.auth.GoogleAuthService
import com.listenai.ui.MainScreen
import com.listenai.ui.onboarding.OnboardingManager
import com.listenai.ui.onboarding.OnboardingScreen
import com.listenai.ui.theme.ListenAITheme
import kotlinx.coroutines.launch
import org.koin.android.ext.android.inject

class MainActivity : ComponentActivity() {

    private lateinit var onboardingManager: OnboardingManager
    private val authService: GoogleAuthService by inject()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Initialize onboarding manager
        onboardingManager = OnboardingManager.getInstance(this)

        // Handle OAuth redirect if launched from browser
        handleOAuthRedirect(intent)

        setContent {
            ListenAITheme {
                val hasCompletedOnboarding by onboardingManager.hasCompletedOnboarding.collectAsState()

                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    if (hasCompletedOnboarding) {
                        MainScreen()
                    } else {
                        OnboardingScreen(
                            onboardingManager = onboardingManager,
                            onComplete = {
                                // State is already updated by OnboardingManager
                            }
                        )
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleOAuthRedirect(intent)
    }

    private fun handleOAuthRedirect(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme?.startsWith("com.googleusercontent.apps") == true) {
            Log.d("MainActivity", "Handling OAuth redirect: $uri")
            lifecycleScope.launch {
                authService.handleOAuthRedirect(uri)
            }
        }
    }
}
