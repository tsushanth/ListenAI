package com.listenai.data.local

import androidx.room.*
import com.listenai.data.models.UsageRecord
import kotlinx.coroutines.flow.Flow

@Dao
interface UsageDao {

    @Query("SELECT * FROM usage_records ORDER BY timestamp DESC")
    fun getAllRecords(): Flow<List<UsageRecord>>

    @Query("SELECT * FROM usage_records WHERE timestamp >= :startTime AND timestamp < :endTime ORDER BY timestamp DESC")
    fun getRecordsInRangeFlow(startTime: Long, endTime: Long): Flow<List<UsageRecord>>

    @Query("SELECT * FROM usage_records WHERE timestamp >= :startTime AND timestamp < :endTime ORDER BY timestamp DESC")
    suspend fun getRecordsInRange(startTime: Long, endTime: Long): List<UsageRecord>

    @Query("SELECT * FROM usage_records WHERE timestamp >= :startTime ORDER BY timestamp DESC")
    suspend fun getRecordsSince(startTime: Long): List<UsageRecord>

    @Query("SELECT SUM(characterCount) FROM usage_records WHERE timestamp >= :startTime AND timestamp < :endTime AND isSuccess = 1")
    suspend fun getTotalCharactersInRange(startTime: Long, endTime: Long): Int?

    @Query("SELECT COUNT(*) FROM usage_records WHERE timestamp >= :startTime AND timestamp < :endTime")
    suspend fun getRequestCountInRange(startTime: Long, endTime: Long): Int

    @Query("SELECT COUNT(*) FROM usage_records WHERE timestamp >= :startTime AND timestamp < :endTime AND isSuccess = 1")
    suspend fun getSuccessfulRequestCountInRange(startTime: Long, endTime: Long): Int

    @Query("SELECT provider, SUM(characterCount) as total FROM usage_records WHERE timestamp >= :startTime AND timestamp < :endTime AND isSuccess = 1 GROUP BY provider")
    suspend fun getCharactersByProviderInRange(startTime: Long, endTime: Long): List<ProviderUsage>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertRecord(record: UsageRecord)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertRecords(records: List<UsageRecord>)

    @Delete
    suspend fun deleteRecord(record: UsageRecord)

    @Query("DELETE FROM usage_records WHERE timestamp < :beforeTime")
    suspend fun deleteRecordsBefore(beforeTime: Long)

    @Query("SELECT * FROM usage_records ORDER BY timestamp DESC LIMIT :limit")
    suspend fun getRecentRecords(limit: Int): List<UsageRecord>

    // Total statistics
    @Query("SELECT SUM(characterCount) FROM usage_records WHERE isSuccess = 1")
    suspend fun getTotalCharactersAllTime(): Int?

    @Query("SELECT COUNT(*) FROM usage_records")
    suspend fun getTotalRequestsAllTime(): Int
}

/**
 * Helper class for provider usage aggregation
 */
data class ProviderUsage(
    val provider: String,
    val total: Int
)
