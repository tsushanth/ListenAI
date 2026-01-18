package com.listenai.di

import androidx.room.Room
import com.listenai.data.local.ListenAIDatabase
import com.listenai.data.repository.ArticleRepository
import com.listenai.data.repository.UsageRepository
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
import org.koin.android.ext.koin.androidContext
import org.koin.dsl.module

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
        ).build()
    }

    // DAOs
    single { get<ListenAIDatabase>().articleDao() }
    single { get<ListenAIDatabase>().playlistDao() }
    single { get<ListenAIDatabase>().usageDao() }

    // Repositories
    single { ArticleRepository(get()) }
    single { UsageRepository(get()) }
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
}

/**
 * All Koin modules
 */
val allModules = listOf(dataModule, serviceModule)
