import XCTest
@testable import ListenAI

// MARK: - Queue Item Tests

final class QueueItemTests: XCTestCase {

    func testQueueItemCreation() {
        let item = QueueItem(
            articleID: UUID(),
            title: "Test Article",
            author: "John Doe",
            sourceType: .web,
            duration: 300,
            wordCount: 500
        )

        XCTAssertEqual(item.title, "Test Article")
        XCTAssertEqual(item.author, "John Doe")
        XCTAssertEqual(item.duration, 300)
        XCTAssertEqual(item.wordCount, 500)
        XCTAssertFalse(item.isCompleted)
    }

    func testQueueItemDurationFormatted() {
        let item = QueueItem(
            articleID: UUID(),
            title: "Test",
            duration: 185 // 3:05
        )

        XCTAssertEqual(item.durationFormatted, "3:05")
    }

    func testQueueItemProgress() {
        var item = QueueItem(
            articleID: UUID(),
            title: "Test",
            duration: 100
        )

        XCTAssertEqual(item.progress, 0)

        item.lastPlayedPosition = 50
        XCTAssertEqual(item.progress, 0.5)

        item.lastPlayedPosition = 100
        XCTAssertEqual(item.progress, 1.0)
    }

    func testQueueItemRemainingDuration() {
        var item = QueueItem(
            articleID: UUID(),
            title: "Test",
            duration: 300
        )

        XCTAssertEqual(item.remainingDuration, 300)

        item.lastPlayedPosition = 100
        XCTAssertEqual(item.remainingDuration, 200)
    }

    func testQueueItemDisplayAuthor() {
        let itemWithAuthor = QueueItem(
            articleID: UUID(),
            title: "Test",
            author: "Jane Doe",
            duration: 100
        )
        XCTAssertEqual(itemWithAuthor.displayAuthor, "Jane Doe")

        let itemWithSite = QueueItem(
            articleID: UUID(),
            title: "Test",
            siteName: "Example.com",
            duration: 100
        )
        XCTAssertEqual(itemWithSite.displayAuthor, "Example.com")

        let itemWithNeither = QueueItem(
            articleID: UUID(),
            title: "Test",
            duration: 100
        )
        XCTAssertEqual(itemWithNeither.displayAuthor, "Unknown")
    }
}

// MARK: - Playlist Tests

final class PlaylistTests: XCTestCase {

    func testPlaylistCreation() {
        let playlist = Playlist(
            name: "My Playlist",
            description: "Test description",
            artworkColor: .blue,
            iconName: "list.bullet"
        )

        XCTAssertEqual(playlist.name, "My Playlist")
        XCTAssertEqual(playlist.description, "Test description")
        XCTAssertTrue(playlist.isEmpty)
        XCTAssertEqual(playlist.itemCount, 0)
    }

    func testPlaylistAddItem() {
        var playlist = Playlist(name: "Test")

        let item = PlaylistItem(
            articleID: UUID(),
            title: "Article 1",
            duration: 100
        )

        playlist.addItem(item)

        XCTAssertEqual(playlist.itemCount, 1)
        XCTAssertFalse(playlist.isEmpty)
    }

    func testPlaylistRemoveItem() {
        var playlist = Playlist(name: "Test")

        let item = PlaylistItem(
            articleID: UUID(),
            title: "Article 1",
            duration: 100
        )

        playlist.addItem(item)
        XCTAssertEqual(playlist.itemCount, 1)

        playlist.removeItem(at: 0)
        XCTAssertEqual(playlist.itemCount, 0)
        XCTAssertTrue(playlist.isEmpty)
    }

    func testPlaylistMoveItem() {
        var playlist = Playlist(name: "Test")

        playlist.addItem(PlaylistItem(articleID: UUID(), title: "A", duration: 100))
        playlist.addItem(PlaylistItem(articleID: UUID(), title: "B", duration: 100))
        playlist.addItem(PlaylistItem(articleID: UUID(), title: "C", duration: 100))

        playlist.moveItem(from: IndexSet([0]), to: 3)

        XCTAssertEqual(playlist.items[0].title, "B")
        XCTAssertEqual(playlist.items[1].title, "C")
        XCTAssertEqual(playlist.items[2].title, "A")
    }

    func testPlaylistTotalDuration() {
        var playlist = Playlist(name: "Test")

        playlist.addItem(PlaylistItem(articleID: UUID(), title: "A", duration: 100))
        playlist.addItem(PlaylistItem(articleID: UUID(), title: "B", duration: 200))
        playlist.addItem(PlaylistItem(articleID: UUID(), title: "C", duration: 300))

        XCTAssertEqual(playlist.totalDuration, 600)
    }

    func testPlaylistTotalDurationFormatted() {
        var playlist = Playlist(name: "Test")

        // Less than an hour
        playlist.addItem(PlaylistItem(articleID: UUID(), title: "A", duration: 1800)) // 30 min
        XCTAssertEqual(playlist.totalDurationFormatted, "30 min")

        // More than an hour
        playlist.addItem(PlaylistItem(articleID: UUID(), title: "B", duration: 3600)) // 60 min
        XCTAssertEqual(playlist.totalDurationFormatted, "1 hr 30 min")
    }
}

// MARK: - Playlist Item Tests

final class PlaylistItemTests: XCTestCase {

    func testPlaylistItemCreation() {
        let item = PlaylistItem(
            articleID: UUID(),
            title: "Test Article",
            author: "Author",
            duration: 180
        )

        XCTAssertEqual(item.title, "Test Article")
        XCTAssertEqual(item.author, "Author")
        XCTAssertEqual(item.duration, 180)
        XCTAssertEqual(item.playCount, 0)
    }

    func testPlaylistItemDurationFormatted() {
        let item = PlaylistItem(
            articleID: UUID(),
            title: "Test",
            duration: 65 // 1:05
        )

        XCTAssertEqual(item.durationFormatted, "1:05")
    }

    func testPlaylistItemFromQueueItem() {
        let queueItem = QueueItem(
            articleID: UUID(),
            title: "Queue Item",
            author: "Author",
            sourceType: .pdf,
            duration: 300
        )

        let playlistItem = PlaylistItem(from: queueItem, sortOrder: 5)

        XCTAssertEqual(playlistItem.articleID, queueItem.articleID)
        XCTAssertEqual(playlistItem.title, queueItem.title)
        XCTAssertEqual(playlistItem.author, queueItem.author)
        XCTAssertEqual(playlistItem.sourceType, .pdf)
        XCTAssertEqual(playlistItem.sortOrder, 5)
    }
}

// MARK: - Smart Playlist Criteria Tests

final class SmartPlaylistCriteriaTests: XCTestCase {

    func testCriteriaMatchesSourceType() {
        let criteria = SmartPlaylistCriteria(sourceTypes: [.web, .pdf])

        let webArticle = Article(
            sourceType: .web,
            title: "Web Article",
            rawText: "Content"
        )
        XCTAssertTrue(criteria.matches(webArticle))

        let pdfArticle = Article(
            sourceType: .pdf,
            title: "PDF Article",
            rawText: "Content"
        )
        XCTAssertTrue(criteria.matches(pdfArticle))

        let clipboardArticle = Article(
            sourceType: .clipboard,
            title: "Clipboard Article",
            rawText: "Content"
        )
        XCTAssertFalse(criteria.matches(clipboardArticle))
    }

    func testCriteriaMatchesDuration() {
        let criteria = SmartPlaylistCriteria(
            minDuration: 60,  // 1 minute
            maxDuration: 300  // 5 minutes
        )

        let shortArticle = Article(
            sourceType: .web,
            title: "Short",
            rawText: String(repeating: "word ", count: 50) // ~20 seconds
        )
        XCTAssertFalse(criteria.matches(shortArticle))

        let mediumArticle = Article(
            sourceType: .web,
            title: "Medium",
            rawText: String(repeating: "word ", count: 300) // ~2 minutes
        )
        XCTAssertTrue(criteria.matches(mediumArticle))

        let longArticle = Article(
            sourceType: .web,
            title: "Long",
            rawText: String(repeating: "word ", count: 1500) // ~10 minutes
        )
        XCTAssertFalse(criteria.matches(longArticle))
    }
}

// MARK: - Queue State Tests

final class QueueStateTests: XCTestCase {

    func testEmptyQueueState() {
        let state = QueueState.empty

        XCTAssertTrue(state.isEmpty)
        XCTAssertNil(state.currentItem)
        XCTAssertTrue(state.upNext.isEmpty)
        XCTAssertFalse(state.hasNext)
        XCTAssertFalse(state.hasPrevious)
    }

    func testQueueStateWithItems() {
        let items = [
            QueueItem(articleID: UUID(), title: "A", duration: 100),
            QueueItem(articleID: UUID(), title: "B", duration: 200),
            QueueItem(articleID: UUID(), title: "C", duration: 300)
        ]

        let state = QueueState(items: items, currentIndex: 0)

        XCTAssertFalse(state.isEmpty)
        XCTAssertEqual(state.currentItem?.title, "A")
        XCTAssertEqual(state.upNext.count, 2)
        XCTAssertTrue(state.hasNext)
        XCTAssertFalse(state.hasPrevious)
    }

    func testQueueStateTotalDuration() {
        let items = [
            QueueItem(articleID: UUID(), title: "A", duration: 100),
            QueueItem(articleID: UUID(), title: "B", duration: 200),
            QueueItem(articleID: UUID(), title: "C", duration: 300)
        ]

        let state = QueueState(items: items)

        XCTAssertEqual(state.totalDuration, 600)
    }

    func testQueueStateHasNextWithRepeat() {
        let items = [
            QueueItem(articleID: UUID(), title: "A", duration: 100)
        ]

        var state = QueueState(items: items, currentIndex: 0, repeatMode: .off)
        XCTAssertFalse(state.hasNext)

        state.repeatMode = .all
        XCTAssertTrue(state.hasNext)
    }
}

// MARK: - Repeat Mode Tests

final class RepeatModeTests: XCTestCase {

    func testRepeatModeNext() {
        XCTAssertEqual(RepeatMode.off.next(), .all)
        XCTAssertEqual(RepeatMode.all.next(), .one)
        XCTAssertEqual(RepeatMode.one.next(), .off)
    }

    func testRepeatModeIconName() {
        XCTAssertEqual(RepeatMode.off.iconName, "repeat")
        XCTAssertEqual(RepeatMode.all.iconName, "repeat")
        XCTAssertEqual(RepeatMode.one.iconName, "repeat.1")
    }

    func testRepeatModeDisplayName() {
        XCTAssertEqual(RepeatMode.off.displayName, "Off")
        XCTAssertEqual(RepeatMode.all.displayName, "Repeat All")
        XCTAssertEqual(RepeatMode.one.displayName, "Repeat One")
    }
}

// MARK: - Shuffle Mode Tests

final class ShuffleModeTests: XCTestCase {

    func testShuffleModeIsEnabled() {
        XCTAssertFalse(ShuffleMode.off.isEnabled)
        XCTAssertTrue(ShuffleMode.on.isEnabled)
    }

    func testShuffleModeToggle() {
        var mode = ShuffleMode.off
        mode.toggle()
        XCTAssertEqual(mode, .on)

        mode.toggle()
        XCTAssertEqual(mode, .off)
    }
}

// MARK: - Codable Color Tests

final class CodableColorTests: XCTestCase {

    func testCodableColorPresets() {
        XCTAssertEqual(CodableColor.blue.red, 0.0)
        XCTAssertEqual(CodableColor.blue.green, 0.478)
        XCTAssertEqual(CodableColor.blue.blue, 1.0)
    }

    func testCodableColorEquality() {
        let color1 = CodableColor(red: 1.0, green: 0.5, blue: 0.0)
        let color2 = CodableColor(red: 1.0, green: 0.5, blue: 0.0)
        let color3 = CodableColor(red: 0.0, green: 0.5, blue: 1.0)

        XCTAssertEqual(color1, color2)
        XCTAssertNotEqual(color1, color3)
    }

    func testCodableColorAllColors() {
        XCTAssertEqual(CodableColor.allColors.count, 9)
        XCTAssertTrue(CodableColor.allColors.contains(.blue))
        XCTAssertTrue(CodableColor.allColors.contains(.purple))
    }
}

// MARK: - Listening History Entry Tests

final class ListeningHistoryEntryTests: XCTestCase {

    func testHistoryEntryCreation() {
        let entry = ListeningHistoryEntry(
            articleID: UUID(),
            title: "Test Article",
            author: "Author",
            durationListened: 180,
            completed: true
        )

        XCTAssertEqual(entry.title, "Test Article")
        XCTAssertEqual(entry.author, "Author")
        XCTAssertEqual(entry.durationListened, 180)
        XCTAssertTrue(entry.completed)
    }

    func testHistoryEntryDisplayDuration() {
        let shortEntry = ListeningHistoryEntry(
            articleID: UUID(),
            title: "Short",
            durationListened: 300 // 5 minutes
        )
        XCTAssertEqual(shortEntry.displayDuration, "5 min")

        let longEntry = ListeningHistoryEntry(
            articleID: UUID(),
            title: "Long",
            durationListened: 3900 // 1 hr 5 min
        )
        XCTAssertEqual(longEntry.displayDuration, "1 hr 5 min")
    }

    func testHistoryEntryFromQueueItem() {
        let queueItem = QueueItem(
            articleID: UUID(),
            title: "Queue Item",
            author: "Author",
            sourceType: .web,
            duration: 300
        )

        let entry = ListeningHistoryEntry(from: queueItem)

        XCTAssertEqual(entry.articleID, queueItem.articleID)
        XCTAssertEqual(entry.title, queueItem.title)
        XCTAssertEqual(entry.author, queueItem.author)
        XCTAssertEqual(entry.sourceType, .web)
        XCTAssertFalse(entry.completed)
    }
}

// MARK: - Queue Position Tests

final class QueuePositionTests: XCTestCase {

    func testQueuePositionCases() {
        // Just verify the enum cases exist and can be used
        let positions: [QueuePosition] = [
            .next,
            .last,
            .first,
            .at(5)
        ]

        XCTAssertEqual(positions.count, 4)

        // Test the at case
        if case .at(let index) = QueuePosition.at(10) {
            XCTAssertEqual(index, 10)
        } else {
            XCTFail("Expected .at case")
        }
    }
}

// MARK: - Playlist Sort Option Tests

final class PlaylistSortOptionTests: XCTestCase {

    func testPlaylistSortOptionDisplayName() {
        XCTAssertEqual(PlaylistSortOption.name.displayName, "Name")
        XCTAssertEqual(PlaylistSortOption.dateCreated.displayName, "Date Created")
        XCTAssertEqual(PlaylistSortOption.dateModified.displayName, "Recently Modified")
        XCTAssertEqual(PlaylistSortOption.itemCount.displayName, "Number of Items")
        XCTAssertEqual(PlaylistSortOption.duration.displayName, "Total Duration")
    }

    func testPlaylistSortOptionAllCases() {
        XCTAssertEqual(PlaylistSortOption.allCases.count, 5)
    }
}
