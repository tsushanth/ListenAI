import XCTest
@testable import ListenAI

final class PlaybackServiceTests: XCTestCase {

    // MARK: - PlaybackState Tests

    func testPlaybackStateProperties() {
        let articleID = UUID()

        // Test isPlaying
        XCTAssertTrue(PlaybackState.playing(articleID: articleID).isPlaying)
        XCTAssertFalse(PlaybackState.paused(articleID: articleID).isPlaying)
        XCTAssertFalse(PlaybackState.idle.isPlaying)

        // Test isPaused
        XCTAssertTrue(PlaybackState.paused(articleID: articleID).isPaused)
        XCTAssertFalse(PlaybackState.playing(articleID: articleID).isPaused)

        // Test isLoading
        XCTAssertTrue(PlaybackState.loading(articleID: articleID).isLoading)
        XCTAssertTrue(PlaybackState.buffering(articleID: articleID).isLoading)
        XCTAssertFalse(PlaybackState.playing(articleID: articleID).isLoading)

        // Test canPlay
        XCTAssertTrue(PlaybackState.paused(articleID: articleID).canPlay)
        XCTAssertTrue(PlaybackState.interrupted(articleID: articleID, reason: .phoneCall).canPlay)
        XCTAssertFalse(PlaybackState.playing(articleID: articleID).canPlay)
        XCTAssertFalse(PlaybackState.idle.canPlay)

        // Test articleID extraction
        XCTAssertEqual(PlaybackState.playing(articleID: articleID).articleID, articleID)
        XCTAssertNil(PlaybackState.idle.articleID)
        XCTAssertNil(PlaybackState.error(message: "test").articleID)
    }

    // MARK: - InterruptionReason Tests

    func testInterruptionReasonDisplayMessages() {
        XCTAssertTrue(InterruptionReason.phoneCall.displayMessage.contains("phone"))
        XCTAssertTrue(InterruptionReason.siri.displayMessage.contains("Siri"))
        XCTAssertTrue(InterruptionReason.routeChange.displayMessage.contains("route"))
    }

    // MARK: - SleepTimerOption Tests

    func testSleepTimerDisplayNames() {
        XCTAssertEqual(SleepTimerOption.off.displayName, "Off")
        XCTAssertEqual(SleepTimerOption.minutes(15).displayName, "15 minutes")
        XCTAssertEqual(SleepTimerOption.endOfArticle.displayName, "End of article")
        XCTAssertEqual(SleepTimerOption.endOfQueue.displayName, "End of queue")
    }

    func testSleepTimerPresets() {
        let presets = SleepTimerOption.presets
        XCTAssertFalse(presets.isEmpty)
        XCTAssertEqual(presets.first, .off)
    }

    // MARK: - RepeatMode Tests

    func testRepeatModeNext() {
        XCTAssertEqual(RepeatMode.off.next, .all)
        XCTAssertEqual(RepeatMode.all.next, .one)
        XCTAssertEqual(RepeatMode.one.next, .off)
    }

    func testRepeatModeIcons() {
        XCTAssertEqual(RepeatMode.off.iconName, "repeat")
        XCTAssertEqual(RepeatMode.one.iconName, "repeat.1")
        XCTAssertEqual(RepeatMode.all.iconName, "repeat")
    }

    // MARK: - PlaybackSpeed Tests

    func testPlaybackSpeedDisplayNames() {
        XCTAssertEqual(PlaybackSpeed(rate: 1.0).displayName, "1x")
        XCTAssertEqual(PlaybackSpeed(rate: 2.0).displayName, "2x")
        XCTAssertEqual(PlaybackSpeed(rate: 1.5).displayName, "1.5x")
        XCTAssertEqual(PlaybackSpeed(rate: 0.75).displayName, "0.75x")
    }

    func testPlaybackSpeedPresets() {
        let speeds = PlaybackSpeed.speeds
        XCTAssertFalse(speeds.isEmpty)
        XCTAssertTrue(speeds.contains(PlaybackSpeed.normal))
    }

    // MARK: - PlaybackProgress Tests

    func testPlaybackProgressCalculations() {
        let progress = PlaybackProgress(
            currentTime: 30,
            duration: 120,
            bufferedTime: 120
        )

        XCTAssertEqual(progress.progress, 0.25)
        XCTAssertEqual(progress.remainingTime, 90)
        XCTAssertEqual(progress.percentComplete, 25)
        XCTAssertFalse(progress.isNearEnd)
        XCTAssertFalse(progress.isComplete)
    }

    func testPlaybackProgressNearEnd() {
        let progress = PlaybackProgress(
            currentTime: 115,
            duration: 120,
            bufferedTime: 120
        )

        XCTAssertTrue(progress.isNearEnd)
    }

    func testPlaybackProgressComplete() {
        let progress = PlaybackProgress(
            currentTime: 118,
            duration: 120,
            bufferedTime: 120
        )

        XCTAssertTrue(progress.isComplete)
    }

    func testPlaybackProgressZero() {
        let progress = PlaybackProgress.zero

        XCTAssertEqual(progress.currentTime, 0)
        XCTAssertEqual(progress.duration, 0)
        XCTAssertEqual(progress.progress, 0)
    }

    // MARK: - ListeningPosition Tests

    func testListeningPositionCreation() {
        let articleID = UUID()
        let position = ListeningPosition(
            articleID: articleID,
            position: 60,
            duration: 120
        )

        XCTAssertEqual(position.articleID, articleID)
        XCTAssertEqual(position.position, 60)
        XCTAssertEqual(position.progress, 0.5)
        XCTAssertFalse(position.isCompleted)
    }

    func testListeningPositionAutoComplete() {
        let articleID = UUID()
        let position = ListeningPosition(
            articleID: articleID,
            position: 118,
            duration: 120
        )

        XCTAssertTrue(position.isCompleted)
    }

    // MARK: - TimeInterval Formatting Tests

    func testTimeIntervalFormatting() {
        XCTAssertEqual(TimeInterval(65).formattedDuration, "1:05")
        XCTAssertEqual(TimeInterval(3665).formattedDuration, "1:01:05")
        XCTAssertEqual(TimeInterval(0).formattedDuration, "0:00")
    }

    func testTimeIntervalShortFormatting() {
        XCTAssertEqual(TimeInterval(3600).formattedDurationShort, "1h 0m")
        XCTAssertEqual(TimeInterval(1800).formattedDurationShort, "30 min")
        XCTAssertEqual(TimeInterval(30).formattedDurationShort, "< 1 min")
    }

    func testTimeIntervalRemainingFormatting() {
        XCTAssertEqual(TimeInterval(65).formattedRemaining, "-1:05")
    }

    // MARK: - PlaybackError Tests

    func testPlaybackErrorDescriptions() {
        let url = URL(fileURLWithPath: "/test.mp3")

        XCTAssertTrue(PlaybackError.fileNotFound(url: url).errorDescription?.contains("test.mp3") ?? false)
        XCTAssertTrue(PlaybackError.audioSessionFailed(reason: "test").errorDescription?.contains("test") ?? false)
        XCTAssertTrue(PlaybackError.interrupted(reason: .phoneCall).errorDescription?.contains("phone") ?? false)
    }

    // MARK: - SkipDirection Tests

    func testSkipDirectionDefaults() {
        XCTAssertEqual(SkipDirection.forward.defaultInterval, 15)
        XCTAssertEqual(SkipDirection.backward.defaultInterval, 15)
    }

    // MARK: - QueueItem Tests

    func testQueueItemCreation() {
        let articleID = UUID()
        let item = QueueItem(
            articleID: articleID,
            title: "Test Article",
            author: "Test Author",
            duration: 300
        )

        XCTAssertEqual(item.articleID, articleID)
        XCTAssertEqual(item.title, "Test Article")
        XCTAssertEqual(item.author, "Test Author")
        XCTAssertEqual(item.duration, 300)
    }

    // MARK: - NowPlayingItem Tests

    func testNowPlayingItemDisplayAuthor() {
        let itemWithAuthor = NowPlayingItem(
            id: UUID(),
            articleID: UUID(),
            title: "Test",
            author: "John Doe",
            siteName: "Example.com",
            audioURL: URL(fileURLWithPath: "/test.mp3"),
            duration: 100,
            artworkURL: nil,
            artworkColor: nil
        )
        XCTAssertEqual(itemWithAuthor.displayAuthor, "John Doe")

        let itemWithSite = NowPlayingItem(
            id: UUID(),
            articleID: UUID(),
            title: "Test",
            author: nil,
            siteName: "Example.com",
            audioURL: URL(fileURLWithPath: "/test.mp3"),
            duration: 100,
            artworkURL: nil,
            artworkColor: nil
        )
        XCTAssertEqual(itemWithSite.displayAuthor, "Example.com")

        let itemWithNeither = NowPlayingItem(
            id: UUID(),
            articleID: UUID(),
            title: "Test",
            author: nil,
            siteName: nil,
            audioURL: URL(fileURLWithPath: "/test.mp3"),
            duration: 100,
            artworkURL: nil,
            artworkColor: nil
        )
        XCTAssertEqual(itemWithNeither.displayAuthor, "Unknown")
    }
}

// MARK: - Background Audio Configuration Tests

final class BackgroundAudioConfigurationTests: XCTestCase {

    func testConfigurationConstants() {
        XCTAssertEqual(BackgroundAudioConfiguration.backgroundModesKey, "UIBackgroundModes")
        XCTAssertEqual(BackgroundAudioConfiguration.audioBackgroundMode, "audio")
    }
}
