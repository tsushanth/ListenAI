package com.listenai

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import com.listenai.ui.MainScreen
import com.listenai.ui.onboarding.OnboardingManager
import com.listenai.ui.onboarding.OnboardingScreen
import com.listenai.ui.theme.ListenAITheme

class MainActivity : ComponentActivity() {

    private lateinit var onboardingManager: OnboardingManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Initialize onboarding manager
        onboardingManager = OnboardingManager.getInstance(this)

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
}
