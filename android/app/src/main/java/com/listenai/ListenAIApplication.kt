package com.listenai

import android.app.Application
import com.listenai.di.allModules
import com.listenai.service.FirebaseAnalyticsHelper
import com.listenai.service.TikTokHelper
import com.listenai.service.billing.RevenueCatManager
import com.listenai.service.import_content.WebImportService
import org.koin.android.ext.android.inject
import org.koin.android.ext.koin.androidContext
import org.koin.android.ext.koin.androidLogger
import org.koin.core.context.startKoin
import org.koin.core.logger.Level

class ListenAIApplication : Application() {

    companion object {
        const val BACKEND_URL = "https://listenai-backend-917362189743.us-central1.run.app"
    }

    override fun onCreate() {
        super.onCreate()

        // Initialize Koin dependency injection
        startKoin {
            androidLogger(Level.DEBUG)
            androidContext(this@ListenAIApplication)
            modules(allModules)
        }

        // Configure services with backend URL
        configureServices()

        // Initialize RevenueCat for subscriptions
        RevenueCatManager.getInstance().configure(this)

        // Initialize Firebase Analytics for Google Ads conversion tracking
        FirebaseAnalyticsHelper.initialize(this)

        // Initialize TikTok Events SDK for install attribution
        TikTokHelper.initialize(this)
    }

    private fun configureServices() {
        // Configure WebImportService for server-side extraction
        val webImportService: WebImportService by inject()
        webImportService.configure(
            backendUrl = BACKEND_URL,
            authTokenProvider = {
                // TODO: Replace with actual Supabase auth token provider
                // In production: return supabaseClient.auth.currentSession?.accessToken ?: ""
                ""
            }
        )
    }
}
