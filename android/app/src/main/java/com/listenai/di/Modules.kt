package com.listenai.di

import androidx.room.Room
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import com.listenai.data.local.ListenAIDatabase
import com.listenai.data.repository.ArticleRepository
import com.listenai.data.repository.UsageRepository
import com.listenai.service.import_content.GmailService
import com.listenai.service.import_content.PDFImportService
import com.listenai.service.import_content.TextCleaningService
import com.listenai.service.import_content.WebImportService
import com.listenai.service.playback.AudioPlaybackService
import com.listenai.service.playback.QueueManager
import com.listenai.service.tts.CloudTTSService
import com.listenai.service.tts.OnDeviceTTSService
import com.listenai.service.tts.SelfHostedTTSService
import com.listenai.service.tts.TTSCoordinator
import com.listenai.service.auth.GoogleAuthService
import com.listenai.service.usage.UsageTrackerService
import com.listenai.service.settings.SettingsManager
import com.listenai.service.voice.VoiceCloningService
import com.listenai.service.review.AppReviewService
import com.listenai.service.notification.TTSNotificationService
import com.listenai.ui.import_content.ImportViewModel
import com.listenai.ui.library.LibraryViewModel
import org.koin.android.ext.koin.androidContext
import org.koin.androidx.viewmodel.dsl.viewModel
import org.koin.dsl.module

/**
 * Database migration from version 1 to 2
 * Adds email-specific metadata columns to articles table
 */
private val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(database: SupportSQLiteDatabase) {
        // Add senderEmail column (nullable TEXT)
        database.execSQL("ALTER TABLE articles ADD COLUMN senderEmail TEXT DEFAULT NULL")
        // Add emailDate column (nullable INTEGER for timestamp)
        database.execSQL("ALTER TABLE articles ADD COLUMN emailDate INTEGER DEFAULT NULL")
    }
}

/**
 * Koin module for data layer dependencies
 */
val dataModule = module {
    // Room Database
    single {
        Room.databaseBuilder(
            androidContext(),
            ListenAIDatabase::class.java,
            "listenai_database"
        )
            .addMigrations(MIGRATION_1_2)
            .build()
    }

    // DAOs
    single { get<ListenAIDatabase>().articleDao() }
    single { get<ListenAIDatabase>().playlistDao() }
    single { get<ListenAIDatabase>().usageDao() }

    // Repositories
    single { ArticleRepository(get()) }
    single { UsageRepository(get()) }

    // ViewModels
    viewModel { LibraryViewModel(get()) }
    viewModel { ImportViewModel(get(), get(), get()) }
}

/**
 * Koin module for service layer dependencies
 */
val serviceModule = module {
    // Import Services
    single { TextCleaningService() }
    single { WebImportService() }
    single { PDFImportService(androidContext()) }

    // Usage Services
    single { UsageTrackerService(androidContext(), get()) }

    // TTS Services
    single { OnDeviceTTSService(androidContext()) }
    single { CloudTTSService(androidContext()) }
    single { SelfHostedTTSService.getInstance(androidContext()) }
    single { TTSCoordinator.getInstance(androidContext(), get()) }

    // Playback Services
    single { AudioPlaybackService(androidContext()) }
    single { QueueManager() }

    // Auth Services
    single { GoogleAuthService(androidContext()) }

    // Gmail Service
    single { GmailService(get()) }

    // Voice Cloning Service (configured with backend URL)
    single {
        VoiceCloningService.getInstance(androidContext()).apply {
            configure("https://listenai-backend-917362189743.us-central1.run.app")
        }
    }

    // Settings Manager
    single { SettingsManager.getInstance(androidContext()) }

    // App Review Service
    single { AppReviewService.getInstance(androidContext()) }

    // TTS Notification Service
    single { TTSNotificationService.getInstance(androidContext()) }
}

/**
 * All Koin modules
 */
val allModules = listOf(dataModule, serviceModule)
