package com.listenai.service.playback

import com.listenai.data.models.Article
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID

/**
 * Queue item representing an article in the listening queue
 */
data class QueueItem(
    val id: UUID = UUID.randomUUID(),
    val article: Article,
    val addedAt: Long = System.currentTimeMillis(),
    val position: Int = 0
)

/**
 * Manages the listening queue for articles.
 * Handles queue ordering, persistence, and playback coordination.
 */
class QueueManager {

    // Queue state
    private val _queue = MutableStateFlow<List<QueueItem>>(emptyList())
    val queue: StateFlow<List<QueueItem>> = _queue.asStateFlow()

    // Current playing item
    private val _currentItem = MutableStateFlow<QueueItem?>(null)
    val currentItem: StateFlow<QueueItem?> = _currentItem.asStateFlow()

    // Current index in queue
    private val _currentIndex = MutableStateFlow(-1)
    val currentIndex: StateFlow<Int> = _currentIndex.asStateFlow()

    // Shuffle and repeat modes
    private val _isShuffleEnabled = MutableStateFlow(false)
    val isShuffleEnabled: StateFlow<Boolean> = _isShuffleEnabled.asStateFlow()

    private val _repeatMode = MutableStateFlow(RepeatMode.OFF)
    val repeatMode: StateFlow<RepeatMode> = _repeatMode.asStateFlow()

    // Original order for shuffle restoration
    private var originalOrder: List<QueueItem> = emptyList()

    enum class RepeatMode {
        OFF,        // No repeat
        ALL,        // Repeat entire queue
        ONE         // Repeat current item
    }

    // MARK: - Queue Management

    /**
     * Add an article to the end of the queue
     */
    fun addToQueue(article: Article) {
        val newItem = QueueItem(
            article = article,
            position = _queue.value.size
        )
        _queue.value = _queue.value + newItem

        // If nothing is playing, set this as current
        if (_currentItem.value == null) {
            _currentItem.value = newItem
            _currentIndex.value = _queue.value.size - 1
        }
    }

    /**
     * Add an article to play next (after current item)
     */
    fun playNext(article: Article) {
        val newItem = QueueItem(
            article = article,
            position = _currentIndex.value + 1
        )

        val currentList = _queue.value.toMutableList()
        val insertIndex = (_currentIndex.value + 1).coerceIn(0, currentList.size)
        currentList.add(insertIndex, newItem)

        // Update positions
        _queue.value = currentList.mapIndexed { index, item ->
            item.copy(position = index)
        }
    }

    /**
     * Remove an item from the queue
     */
    fun removeFromQueue(itemId: UUID) {
        val currentList = _queue.value.toMutableList()
        val removeIndex = currentList.indexOfFirst { it.id == itemId }

        if (removeIndex >= 0) {
            currentList.removeAt(removeIndex)

            // Update current index if needed
            if (removeIndex < _currentIndex.value) {
                _currentIndex.value -= 1
            } else if (removeIndex == _currentIndex.value) {
                // Current item was removed, move to next or previous
                if (currentList.isNotEmpty()) {
                    val newIndex = removeIndex.coerceAtMost(currentList.size - 1)
                    _currentIndex.value = newIndex
                    _currentItem.value = currentList.getOrNull(newIndex)
                } else {
                    _currentIndex.value = -1
                    _currentItem.value = null
                }
            }

            // Update positions
            _queue.value = currentList.mapIndexed { index, item ->
                item.copy(position = index)
            }
        }
    }

    /**
     * Clear the entire queue
     */
    fun clearQueue() {
        _queue.value = emptyList()
        _currentItem.value = null
        _currentIndex.value = -1
        originalOrder = emptyList()
    }

    /**
     * Move an item to a new position in the queue
     */
    fun moveItem(fromIndex: Int, toIndex: Int) {
        val currentList = _queue.value.toMutableList()

        if (fromIndex in currentList.indices && toIndex in currentList.indices) {
            val item = currentList.removeAt(fromIndex)
            currentList.add(toIndex, item)

            // Update current index if affected
            when {
                fromIndex == _currentIndex.value -> _currentIndex.value = toIndex
                fromIndex < _currentIndex.value && toIndex >= _currentIndex.value -> _currentIndex.value -= 1
                fromIndex > _currentIndex.value && toIndex <= _currentIndex.value -> _currentIndex.value += 1
            }

            // Update positions
            _queue.value = currentList.mapIndexed { index, item ->
                item.copy(position = index)
            }
        }
    }

    // MARK: - Playback Control

    /**
     * Set the current playing item by index
     */
    fun playAtIndex(index: Int) {
        if (index in _queue.value.indices) {
            _currentIndex.value = index
            _currentItem.value = _queue.value[index]
        }
    }

    /**
     * Set the current playing item by ID
     */
    fun playItem(itemId: UUID) {
        val index = _queue.value.indexOfFirst { it.id == itemId }
        if (index >= 0) {
            playAtIndex(index)
        }
    }

    /**
     * Move to next item in queue
     * Returns true if there is a next item, false if at end
     */
    fun next(): Boolean {
        return when (_repeatMode.value) {
            RepeatMode.ONE -> {
                // Stay on current item
                true
            }
            RepeatMode.ALL -> {
                val nextIndex = (_currentIndex.value + 1) % _queue.value.size
                playAtIndex(nextIndex)
                true
            }
            RepeatMode.OFF -> {
                val nextIndex = _currentIndex.value + 1
                if (nextIndex < _queue.value.size) {
                    playAtIndex(nextIndex)
                    true
                } else {
                    false
                }
            }
        }
    }

    /**
     * Move to previous item in queue
     * Returns true if there is a previous item
     */
    fun previous(): Boolean {
        return when (_repeatMode.value) {
            RepeatMode.ONE -> {
                // Stay on current item
                true
            }
            RepeatMode.ALL -> {
                val prevIndex = if (_currentIndex.value <= 0) {
                    _queue.value.size - 1
                } else {
                    _currentIndex.value - 1
                }
                playAtIndex(prevIndex)
                true
            }
            RepeatMode.OFF -> {
                val prevIndex = _currentIndex.value - 1
                if (prevIndex >= 0) {
                    playAtIndex(prevIndex)
                    true
                } else {
                    false
                }
            }
        }
    }

    // MARK: - Shuffle and Repeat

    /**
     * Toggle shuffle mode
     */
    fun toggleShuffle() {
        _isShuffleEnabled.value = !_isShuffleEnabled.value

        if (_isShuffleEnabled.value) {
            // Save original order and shuffle
            originalOrder = _queue.value.toList()
            val currentItem = _currentItem.value
            val otherItems = _queue.value.filter { it.id != currentItem?.id }.shuffled()

            // Keep current item at front, shuffle rest
            _queue.value = if (currentItem != null) {
                listOf(currentItem) + otherItems
            } else {
                otherItems
            }.mapIndexed { index, item -> item.copy(position = index) }

            _currentIndex.value = 0
        } else {
            // Restore original order
            val currentItemId = _currentItem.value?.id
            _queue.value = originalOrder.mapIndexed { index, item -> item.copy(position = index) }
            _currentIndex.value = _queue.value.indexOfFirst { it.id == currentItemId }.coerceAtLeast(0)
        }
    }

    /**
     * Cycle through repeat modes: OFF -> ALL -> ONE -> OFF
     */
    fun cycleRepeatMode() {
        _repeatMode.value = when (_repeatMode.value) {
            RepeatMode.OFF -> RepeatMode.ALL
            RepeatMode.ALL -> RepeatMode.ONE
            RepeatMode.ONE -> RepeatMode.OFF
        }
    }

    /**
     * Set repeat mode directly
     */
    fun setRepeatMode(mode: RepeatMode) {
        _repeatMode.value = mode
    }

    // MARK: - Queue Info

    /**
     * Check if there's a next item available
     */
    fun hasNext(): Boolean {
        return when (_repeatMode.value) {
            RepeatMode.ONE, RepeatMode.ALL -> _queue.value.isNotEmpty()
            RepeatMode.OFF -> _currentIndex.value < _queue.value.size - 1
        }
    }

    /**
     * Check if there's a previous item available
     */
    fun hasPrevious(): Boolean {
        return when (_repeatMode.value) {
            RepeatMode.ONE, RepeatMode.ALL -> _queue.value.isNotEmpty()
            RepeatMode.OFF -> _currentIndex.value > 0
        }
    }

    /**
     * Get total queue duration in milliseconds
     */
    fun totalDuration(): Long {
        return _queue.value.sumOf { it.article.estimatedDuration }
    }

    /**
     * Get remaining queue duration from current position in milliseconds
     */
    fun remainingDuration(): Long {
        if (_currentIndex.value < 0) return 0L
        return _queue.value.drop(_currentIndex.value).sumOf { it.article.estimatedDuration }
    }

    /**
     * Check if queue contains an article
     */
    fun contains(articleId: String): Boolean {
        return _queue.value.any { it.article.id == articleId }
    }

    /**
     * Get queue item for an article
     */
    fun getQueueItem(articleId: String): QueueItem? {
        return _queue.value.find { it.article.id == articleId }
    }
}
