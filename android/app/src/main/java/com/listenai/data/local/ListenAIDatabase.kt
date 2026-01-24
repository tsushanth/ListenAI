package com.listenai.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import com.listenai.data.models.Article
import com.listenai.data.models.UsageRecord

@Database(
    entities = [
        Article::class,
        PlaylistEntity::class,
        UsageRecord::class
    ],
    version = 2,
    exportSchema = false
)
@TypeConverters(Converters::class)
abstract class ListenAIDatabase : RoomDatabase() {

    abstract fun articleDao(): ArticleDao
    abstract fun playlistDao(): PlaylistDao
    abstract fun usageDao(): UsageDao

    companion object {
        const val DATABASE_NAME = "listenai_database"
    }
}
