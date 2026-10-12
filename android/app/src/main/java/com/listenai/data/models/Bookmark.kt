package com.listenai.data.models

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** A saved point in an article's audio, so a listener can jump back to it later. */
@Entity(tableName = "bookmarks", indices = [Index("articleId")])
data class Bookmark(
    @PrimaryKey val id: String,
    val articleId: String,
    val positionSeconds: Double,
    val createdAt: Long
)
