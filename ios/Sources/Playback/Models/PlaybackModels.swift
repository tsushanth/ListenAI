import Foundation
import SwiftUI

// MARK: - Playback State

enum PlaybackState: Equatable, Sendable {
    case idle
    case loading(articleID: UUID)
    case playing(articleID: UUID)
    case paused(articleID: UUID)
    case buffering(articleID: UUID)
    case interrupted(articleID: UUID, reason: InterruptionReason)
    case error(message: String)

    var articleID: UUID? {
        switch self {
        case .idle, .error:
            return nil
        case .loading(let id), .playing(let id), .paused(let id),
             .buffering(let id), .interrupted(let id, _):
            return id
        }
    }

    var isPlaying: Bool {
        if case .playing = self { return true }
        return false
    }

    var isPaused: Bool {
        if case .paused = self { return true }
        return false
    }

    var isLoading: Bool {
        if case .loading = self { return true }
        if case .buffering = self { return true }
        return false
    }

    var canPlay: Bool {
        switch self {
        case .paused, .interrupted:
            return true
        default:
            return false
        }
    }
}

// MARK: - Interruption Reason

enum InterruptionReason: String, Codable, Sendable {
    case phoneCall
    case siri
    case otherAudioApp
    case routeChange
    case systemAlert

    var displayMessage: String {
        switch self {
        case .phoneCall:
            return "Paused for phone call"
        case .siri:
            return "Paused for Siri"
        case .otherAudioApp:
            return "Paused by another app"
        case .routeChange:
            return "Audio route changed"
        case .systemAlert:
            return "Paused by system"
        }
    }
}

// MARK: - Sleep Timer

enum SleepTimerOption: Equatable, Sendable {
    case off
    case minutes(Int)
    case endOfArticle
    case endOfQueue

    var displayName: String {
        switch self {
        case .off:
            return "Off"
        case .minutes(let mins):
            return "\(mins) minutes"
        case .endOfArticle:
            return "End of article"
        case .endOfQueue:
            return "End of queue"
        }
    }

    static let presets: [SleepTimerOption] = [
        .off,
        .minutes(5),
        .minutes(10),
        .minutes(15),
        .minutes(30),
        .minutes(45),
        .minutes(60),
        .endOfArticle,
        .endOfQueue
    ]
}

// MARK: - Playback Speed

struct PlaybackSpeed: Equatable, Sendable {
    let rate: Float

    static let speeds: [PlaybackSpeed] = [
        PlaybackSpeed(rate: 0.5),
        PlaybackSpeed(rate: 0.75),
        PlaybackSpeed(rate: 1.0),
        PlaybackSpeed(rate: 1.25),
        PlaybackSpeed(rate: 1.5),
        PlaybackSpeed(rate: 1.75),
        PlaybackSpeed(rate: 2.0),
        PlaybackSpeed(rate: 2.5),
        PlaybackSpeed(rate: 3.0)
    ]

    var displayName: String {
        if rate == 1.0 {
            return "1x"
        } else if rate == floor(rate) {
            return "\(Int(rate))x"
        } else {
            return String(format: "%.2gx", rate)
        }
    }

    static let normal = PlaybackSpeed(rate: 1.0)
}

// MARK: - Now Playing Item

struct NowPlayingItem: Identifiable, Equatable, Sendable {
    let id: UUID
    let articleID: UUID
    let title: String
    let author: String?
    let siteName: String?
    let audioURL: URL
    let duration: TimeInterval
    let artworkURL: URL?
    let artworkColor: Color?

    var displayAuthor: String {
        author ?? siteName ?? "Unknown"
    }
}

// MARK: - Playback Progress

struct PlaybackProgress: Equatable, Sendable {
    let currentTime: TimeInterval
    let duration: TimeInterval
    let bufferedTime: TimeInterval

    var progress: Double {
        guard duration > 0 else { return 0 }
        return currentTime / duration
    }

    var remainingTime: TimeInterval {
        max(0, duration - currentTime)
    }

    var percentComplete: Int {
        Int(progress * 100)
    }

    var isNearEnd: Bool {
        remainingTime < 30 // Less than 30 seconds
    }

    var isComplete: Bool {
        progress >= 0.95
    }

    static let zero = PlaybackProgress(currentTime: 0, duration: 0, bufferedTime: 0)
}

// MARK: - Listening Position

struct ListeningPosition: Codable, Equatable, Sendable {
    let articleID: UUID
    let position: TimeInterval
    let duration: TimeInterval
    let updatedAt: Date
    let isCompleted: Bool

    var progress: Double {
        guard duration > 0 else { return 0 }
        return position / duration
    }

    init(
        articleID: UUID,
        position: TimeInterval,
        duration: TimeInterval,
        updatedAt: Date = Date(),
        isCompleted: Bool = false
    ) {
        self.articleID = articleID
        self.position = position
        self.duration = duration
        self.updatedAt = updatedAt
        self.isCompleted = isCompleted || (duration > 0 && position / duration >= 0.95)
    }
}

// MARK: - Audio Session State

struct AudioSessionState: Equatable, Sendable {
    let isActive: Bool
    let category: String
    let mode: String
    let outputRoute: String
    let isHeadphonesConnected: Bool
    let isBluetoothConnected: Bool

    static let inactive = AudioSessionState(
        isActive: false,
        category: "",
        mode: "",
        outputRoute: "",
        isHeadphonesConnected: false,
        isBluetoothConnected: false
    )
}

// MARK: - Playback Error

enum PlaybackError: LocalizedError, Sendable {
    case fileNotFound(url: URL)
    case audioSessionFailed(reason: String)
    case playerInitFailed(reason: String)
    case decodingFailed(reason: String)
    case interrupted(reason: InterruptionReason)
    case networkError(reason: String)
    case unknown(reason: String)

    var errorDescription: String? {
        switch self {
        case .fileNotFound(let url):
            return "Audio file not found: \(url.lastPathComponent)"
        case .audioSessionFailed(let reason):
            return "Audio session error: \(reason)"
        case .playerInitFailed(let reason):
            return "Player initialization failed: \(reason)"
        case .decodingFailed(let reason):
            return "Audio decoding failed: \(reason)"
        case .interrupted(let reason):
            return reason.displayMessage
        case .networkError(let reason):
            return "Network error: \(reason)"
        case .unknown(let reason):
            return "Playback error: \(reason)"
        }
    }
}

// MARK: - Skip Direction

enum SkipDirection: Sendable {
    case forward
    case backward

    var defaultInterval: TimeInterval {
        switch self {
        case .forward: return 15
        case .backward: return 15
        }
    }
}

// MARK: - Time Formatting

extension TimeInterval {
    var formattedDuration: String {
        let totalSeconds = Int(self)
        let hours = totalSeconds / 3600
        let minutes = (totalSeconds % 3600) / 60
        let seconds = totalSeconds % 60

        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        } else {
            return String(format: "%d:%02d", minutes, seconds)
        }
    }

    var formattedDurationShort: String {
        let totalSeconds = Int(self)
        let hours = totalSeconds / 3600
        let minutes = (totalSeconds % 3600) / 60

        if hours > 0 {
            return "\(hours)h \(minutes)m"
        } else if minutes > 0 {
            return "\(minutes) min"
        } else {
            return "< 1 min"
        }
    }

    var formattedRemaining: String {
        "-\(formattedDuration)"
    }
}
