package com.listenai.data.local

import androidx.room.TypeConverter
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.listenai.data.models.SourceType
import java.util.Date

/**
 * Room type converters for complex types
 */
class Converters {
    private val gson = Gson()

    // Date converters
    @TypeConverter
    fun fromTimestamp(value: Long?): Date? {
        return value?.let { Date(it) }
    }

    @TypeConverter
    fun dateToTimestamp(date: Date?): Long? {
        return date?.time
    }

    // SourceType converters
    @TypeConverter
    fun fromSourceType(value: SourceType): String {
        return value.name
    }

    @TypeConverter
    fun toSourceType(value: String): SourceType {
        return SourceType.valueOf(value)
    }

    // List<String> converters
    @TypeConverter
    fun fromStringList(value: List<String>): String {
        return gson.toJson(value)
    }

    @TypeConverter
    fun toStringList(value: String): List<String> {
        val listType = object : TypeToken<List<String>>() {}.type
        return gson.fromJson(value, listType) ?: emptyList()
    }
}
