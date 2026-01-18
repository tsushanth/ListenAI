package com.listenai.data.local

import androidx.room.*
import kotlinx.coroutines.flow.Flow

/**
 * Playlist entity for Room
 */
@Entity(tableName = "playlists")
data class PlaylistEntity(
    @PrimaryKey
    val id: String,
    val name: String,
    val description: String?,
    val iconName: String?,
    val artworkColor: Long?,
    val isSmartPlaylist: Boolean = false,
    val smartCriteria: String? = null, // JSON encoded
    val itemIds: String = "[]", // JSON encoded list of article IDs
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis()
)

@Dao
interface PlaylistDao {

    @Query("SELECT * FROM playlists ORDER BY updatedAt DESC")
    fun getAllPlaylists(): Flow<List<PlaylistEntity>>

    @Query("SELECT * FROM playlists WHERE id = :id")
    suspend fun getPlaylistById(id: String): PlaylistEntity?

    @Query("SELECT * FROM playlists WHERE id = :id")
    fun getPlaylistByIdFlow(id: String): Flow<PlaylistEntity?>

    @Query("SELECT * FROM playlists WHERE isSmartPlaylist = 0 ORDER BY updatedAt DESC")
    fun getManualPlaylists(): Flow<List<PlaylistEntity>>

    @Query("SELECT * FROM playlists WHERE isSmartPlaylist = 1 ORDER BY updatedAt DESC")
    fun getSmartPlaylists(): Flow<List<PlaylistEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertPlaylist(playlist: PlaylistEntity)

    @Update
    suspend fun updatePlaylist(playlist: PlaylistEntity)

    @Delete
    suspend fun deletePlaylist(playlist: PlaylistEntity)

    @Query("DELETE FROM playlists WHERE id = :id")
    suspend fun deletePlaylistById(id: String)

    @Query("UPDATE playlists SET itemIds = :itemIds, updatedAt = :updatedAt WHERE id = :id")
    suspend fun updatePlaylistItems(id: String, itemIds: String, updatedAt: Long = System.currentTimeMillis())

    @Query("UPDATE playlists SET name = :name, description = :description, updatedAt = :updatedAt WHERE id = :id")
    suspend fun updatePlaylistDetails(id: String, name: String, description: String?, updatedAt: Long = System.currentTimeMillis())

    @Query("SELECT COUNT(*) FROM playlists")
    suspend fun getPlaylistCount(): Int
}
