import Foundation
import MediaPlayer
import UIKit

// MARK: - Now Playing Manager

/// Manages the Now Playing info center and remote command center for lock screen/control center controls.
final class NowPlayingManager {

    // MARK: - Properties

    private let nowPlayingInfoCenter = MPNowPlayingInfoCenter.default()
    private let remoteCommandCenter = MPRemoteCommandCenter.shared()

    // Command handlers
    var onPlay: (() -> Void)?
    var onPause: (() -> Void)?
    var onTogglePlayPause: (() -> Void)?
    var onNextTrack: (() -> Void)?
    var onPreviousTrack: (() -> Void)?
    var onSkipForward: ((TimeInterval) -> Void)?
    var onSkipBackward: ((TimeInterval) -> Void)?
    var onSeek: ((TimeInterval) -> Void)?
    var onChangePlaybackRate: ((Float) -> Void)?

    // Skip intervals
    var skipForwardInterval: TimeInterval = 15
    var skipBackwardInterval: TimeInterval = 15

    // MARK: - Singleton

    static let shared = NowPlayingManager()

    // MARK: - Initialization

    private init() {
        setupRemoteCommands()
    }

    // MARK: - Now Playing Info

    /// Update the now playing info displayed on lock screen and control center
    func updateNowPlayingInfo(
        item: NowPlayingItem,
        currentTime: TimeInterval,
        duration: TimeInterval,
        rate: Float,
        isPlaying: Bool
    ) {
        var nowPlayingInfo: [String: Any] = [
            MPMediaItemPropertyTitle: item.title,
            MPMediaItemPropertyArtist: item.displayAuthor,
            MPMediaItemPropertyAlbumTitle: "ReadAloud AI",
            MPMediaItemPropertyMediaType: MPMediaType.podcast.rawValue,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? rate : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue
        ]

        // Add artwork if available
        if let artworkURL = item.artworkURL {
            loadArtwork(from: artworkURL) { [weak self] artwork in
                if let artwork = artwork {
                    var updatedInfo = self?.nowPlayingInfoCenter.nowPlayingInfo ?? nowPlayingInfo
                    updatedInfo[MPMediaItemPropertyArtwork] = artwork
                    self?.nowPlayingInfoCenter.nowPlayingInfo = updatedInfo
                }
            }
        } else if let color = item.artworkColor {
            // Generate placeholder artwork with color
            let artwork = generatePlaceholderArtwork(title: item.title, color: UIColor(color))
            nowPlayingInfo[MPMediaItemPropertyArtwork] = artwork
        }

        nowPlayingInfoCenter.nowPlayingInfo = nowPlayingInfo
    }

    /// Update just the playback position (for frequent updates)
    func updatePlaybackPosition(currentTime: TimeInterval, rate: Float, isPlaying: Bool) {
        guard var nowPlayingInfo = nowPlayingInfoCenter.nowPlayingInfo else { return }

        nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime
        nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? rate : 0.0

        nowPlayingInfoCenter.nowPlayingInfo = nowPlayingInfo
    }

    /// Update the playback rate
    func updatePlaybackRate(_ rate: Float, isPlaying: Bool) {
        guard var nowPlayingInfo = nowPlayingInfoCenter.nowPlayingInfo else { return }

        nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? rate : 0.0
        nowPlayingInfo[MPNowPlayingInfoPropertyDefaultPlaybackRate] = rate

        nowPlayingInfoCenter.nowPlayingInfo = nowPlayingInfo
    }

    /// Clear the now playing info
    func clearNowPlayingInfo() {
        nowPlayingInfoCenter.nowPlayingInfo = nil
    }

    // MARK: - Remote Commands Setup

    private func setupRemoteCommands() {
        // Play command
        remoteCommandCenter.playCommand.isEnabled = true
        remoteCommandCenter.playCommand.addTarget { [weak self] _ in
            self?.onPlay?()
            return .success
        }

        // Pause command
        remoteCommandCenter.pauseCommand.isEnabled = true
        remoteCommandCenter.pauseCommand.addTarget { [weak self] _ in
            self?.onPause?()
            return .success
        }

        // Toggle play/pause (for AirPods tap)
        remoteCommandCenter.togglePlayPauseCommand.isEnabled = true
        remoteCommandCenter.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.onTogglePlayPause?()
            return .success
        }

        // Next track
        remoteCommandCenter.nextTrackCommand.isEnabled = true
        remoteCommandCenter.nextTrackCommand.addTarget { [weak self] _ in
            self?.onNextTrack?()
            return .success
        }

        // Previous track
        remoteCommandCenter.previousTrackCommand.isEnabled = true
        remoteCommandCenter.previousTrackCommand.addTarget { [weak self] _ in
            self?.onPreviousTrack?()
            return .success
        }

        // Skip forward
        remoteCommandCenter.skipForwardCommand.isEnabled = true
        remoteCommandCenter.skipForwardCommand.preferredIntervals = [NSNumber(value: skipForwardInterval)]
        remoteCommandCenter.skipForwardCommand.addTarget { [weak self] event in
            guard let command = event as? MPSkipIntervalCommandEvent else {
                return .commandFailed
            }
            self?.onSkipForward?(command.interval)
            return .success
        }

        // Skip backward
        remoteCommandCenter.skipBackwardCommand.isEnabled = true
        remoteCommandCenter.skipBackwardCommand.preferredIntervals = [NSNumber(value: skipBackwardInterval)]
        remoteCommandCenter.skipBackwardCommand.addTarget { [weak self] event in
            guard let command = event as? MPSkipIntervalCommandEvent else {
                return .commandFailed
            }
            self?.onSkipBackward?(command.interval)
            return .success
        }

        // Seek (scrubber)
        remoteCommandCenter.changePlaybackPositionCommand.isEnabled = true
        remoteCommandCenter.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let command = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self?.onSeek?(command.positionTime)
            return .success
        }

        // Change playback rate
        remoteCommandCenter.changePlaybackRateCommand.isEnabled = true
        remoteCommandCenter.changePlaybackRateCommand.supportedPlaybackRates = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
        remoteCommandCenter.changePlaybackRateCommand.addTarget { [weak self] event in
            guard let command = event as? MPChangePlaybackRateCommandEvent else {
                return .commandFailed
            }
            self?.onChangePlaybackRate?(command.playbackRate)
            return .success
        }

        // Disable unused commands
        remoteCommandCenter.seekForwardCommand.isEnabled = false
        remoteCommandCenter.seekBackwardCommand.isEnabled = false
        remoteCommandCenter.ratingCommand.isEnabled = false
        remoteCommandCenter.likeCommand.isEnabled = false
        remoteCommandCenter.dislikeCommand.isEnabled = false
        remoteCommandCenter.bookmarkCommand.isEnabled = false
    }

    /// Update skip intervals
    func updateSkipIntervals(forward: TimeInterval, backward: TimeInterval) {
        skipForwardInterval = forward
        skipBackwardInterval = backward

        remoteCommandCenter.skipForwardCommand.preferredIntervals = [NSNumber(value: forward)]
        remoteCommandCenter.skipBackwardCommand.preferredIntervals = [NSNumber(value: backward)]
    }

    /// Enable or disable next/previous track commands
    func setTrackNavigationEnabled(_ enabled: Bool) {
        remoteCommandCenter.nextTrackCommand.isEnabled = enabled
        remoteCommandCenter.previousTrackCommand.isEnabled = enabled
    }

    // MARK: - Artwork

    private func loadArtwork(from url: URL, completion: @escaping (MPMediaItemArtwork?) -> Void) {
        // Load artwork asynchronously
        DispatchQueue.global(qos: .userInitiated).async {
            guard let data = try? Data(contentsOf: url),
                  let image = UIImage(data: data) else {
                DispatchQueue.main.async {
                    completion(nil)
                }
                return
            }

            let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }

            DispatchQueue.main.async {
                completion(artwork)
            }
        }
    }

    private func generatePlaceholderArtwork(title: String, color: UIColor) -> MPMediaItemArtwork {
        let size = CGSize(width: 600, height: 600)

        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { context in
            // Background
            color.setFill()
            context.fill(CGRect(origin: .zero, size: size))

            // Icon
            let iconSize: CGFloat = 200
            let iconRect = CGRect(
                x: (size.width - iconSize) / 2,
                y: (size.height - iconSize) / 2 - 40,
                width: iconSize,
                height: iconSize
            )

            let config = UIImage.SymbolConfiguration(pointSize: iconSize, weight: .light)
            if let icon = UIImage(systemName: "headphones", withConfiguration: config) {
                icon.withTintColor(.white).draw(in: iconRect)
            }

            // Title (first letter)
            let letter = String(title.prefix(1)).uppercased()
            let font = UIFont.systemFont(ofSize: 120, weight: .bold)
            let attributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: UIColor.white.withAlphaComponent(0.9)
            ]

            let textSize = letter.size(withAttributes: attributes)
            let textRect = CGRect(
                x: (size.width - textSize.width) / 2,
                y: size.height - textSize.height - 100,
                width: textSize.width,
                height: textSize.height
            )

            letter.draw(in: textRect, withAttributes: attributes)
        }

        return MPMediaItemArtwork(boundsSize: size) { _ in image }
    }
}

// MARK: - UIColor Extension for SwiftUI Color

import SwiftUI

extension UIColor {
    convenience init(_ color: Color) {
        let components = color.cgColor?.components ?? [0, 0, 0, 1]
        self.init(
            red: components[0],
            green: components.count > 1 ? components[1] : 0,
            blue: components.count > 2 ? components[2] : 0,
            alpha: components.count > 3 ? components[3] : 1
        )
    }
}
