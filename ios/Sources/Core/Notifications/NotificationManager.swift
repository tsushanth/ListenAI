import Foundation
import UserNotifications
import os

/// Manages local notifications for the app.
/// Used for notifying users when background synthesis tasks complete.
@MainActor
final class NotificationManager: NSObject, ObservableObject {
    static let shared = NotificationManager()

    private let logger = Logger(subsystem: "com.listenai", category: "NotificationManager")

    /// Whether the user has granted notification permissions
    @Published private(set) var isAuthorized = false

    /// Notification categories
    enum Category: String {
        case synthesisComplete = "SYNTHESIS_COMPLETE"
        case voiceCloneReady = "VOICE_CLONE_READY"
    }

    /// Notification actions
    enum Action: String {
        case play = "PLAY_ACTION"
        case dismiss = "DISMISS_ACTION"
    }

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
        Task {
            await checkAuthorizationStatus()
        }
    }

    // MARK: - Authorization

    /// Check current authorization status
    func checkAuthorizationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        await MainActor.run {
            isAuthorized = settings.authorizationStatus == .authorized
        }
    }

    /// Request notification permissions
    /// - Returns: Whether permission was granted
    @discardableResult
    func requestAuthorization() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(
                options: [.alert, .sound, .badge]
            )

            await MainActor.run {
                isAuthorized = granted
            }

            if granted {
                await registerCategories()
                logger.info("Notification permission granted")
            } else {
                logger.info("Notification permission denied")
            }

            return granted
        } catch {
            logger.error("Failed to request notification permission: \(error.localizedDescription)")
            return false
        }
    }

    /// Register notification categories with actions
    private func registerCategories() async {
        let playAction = UNNotificationAction(
            identifier: Action.play.rawValue,
            title: "Play",
            options: [.foreground]
        )

        let dismissAction = UNNotificationAction(
            identifier: Action.dismiss.rawValue,
            title: "Dismiss",
            options: []
        )

        let synthesisCategory = UNNotificationCategory(
            identifier: Category.synthesisComplete.rawValue,
            actions: [playAction, dismissAction],
            intentIdentifiers: [],
            options: []
        )

        let voiceCloneCategory = UNNotificationCategory(
            identifier: Category.voiceCloneReady.rawValue,
            actions: [playAction, dismissAction],
            intentIdentifiers: [],
            options: []
        )

        UNUserNotificationCenter.current().setNotificationCategories([
            synthesisCategory,
            voiceCloneCategory
        ])
    }

    // MARK: - Sending Notifications

    /// Send a notification when article synthesis is complete
    /// - Parameters:
    ///   - articleId: The article ID for deep linking
    ///   - articleTitle: The article title for the notification
    ///   - audioURL: Optional audio URL to include in the notification
    func notifySynthesisComplete(
        articleId: String,
        articleTitle: String,
        audioURL: URL? = nil
    ) async {
        guard isAuthorized else {
            logger.debug("Skipping notification - not authorized")
            return
        }

        let content = UNMutableNotificationContent()
        content.title = "Ready to Listen"
        content.body = articleTitle.count > 50
            ? String(articleTitle.prefix(47)) + "..."
            : articleTitle
        content.sound = .default
        content.categoryIdentifier = Category.synthesisComplete.rawValue
        content.userInfo = [
            "articleId": articleId,
            "audioURL": audioURL?.absoluteString ?? ""
        ]

        // Use article ID as identifier to prevent duplicates
        let request = UNNotificationRequest(
            identifier: "synthesis-\(articleId)",
            content: content,
            trigger: nil // Deliver immediately
        )

        do {
            try await UNUserNotificationCenter.current().add(request)
            logger.info("Sent synthesis complete notification for article: \(articleId)")
        } catch {
            logger.error("Failed to send notification: \(error.localizedDescription)")
        }
    }

    /// Send a notification when voice clone preview is ready
    /// - Parameters:
    ///   - voiceId: The cloned voice ID
    ///   - voiceName: The name of the cloned voice
    func notifyVoiceCloneReady(
        voiceId: String,
        voiceName: String
    ) async {
        guard isAuthorized else {
            logger.debug("Skipping notification - not authorized")
            return
        }

        let content = UNMutableNotificationContent()
        content.title = "Voice Clone Ready"
        content.body = "\"\(voiceName)\" is ready to preview"
        content.sound = .default
        content.categoryIdentifier = Category.voiceCloneReady.rawValue
        content.userInfo = [
            "voiceId": voiceId,
            "voiceName": voiceName
        ]

        let request = UNNotificationRequest(
            identifier: "voice-clone-\(voiceId)",
            content: content,
            trigger: nil
        )

        do {
            try await UNUserNotificationCenter.current().add(request)
            logger.info("Sent voice clone ready notification for: \(voiceName)")
        } catch {
            logger.error("Failed to send notification: \(error.localizedDescription)")
        }
    }

    /// Cancel pending notifications for an article
    func cancelNotification(forArticle articleId: String) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(
            withIdentifiers: ["synthesis-\(articleId)"]
        )
    }

    /// Cancel pending notifications for a voice clone
    func cancelNotification(forVoiceClone voiceId: String) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(
            withIdentifiers: ["voice-clone-\(voiceId)"]
        )
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension NotificationManager: UNUserNotificationCenterDelegate {
    /// Handle notification when app is in foreground
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // Show banner even when app is in foreground
        return [.banner, .sound]
    }

    /// Handle notification tap/action
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        let category = response.notification.request.content.categoryIdentifier
        let actionIdentifier = response.actionIdentifier

        await MainActor.run {
            switch category {
            case Category.synthesisComplete.rawValue:
                handleSynthesisNotificationAction(
                    action: actionIdentifier,
                    userInfo: userInfo
                )

            case Category.voiceCloneReady.rawValue:
                handleVoiceCloneNotificationAction(
                    action: actionIdentifier,
                    userInfo: userInfo
                )

            default:
                break
            }
        }
    }

    @MainActor
    private func handleSynthesisNotificationAction(
        action: String,
        userInfo: [AnyHashable: Any]
    ) {
        guard let articleId = userInfo["articleId"] as? String else { return }

        switch action {
        case Action.play.rawValue, UNNotificationDefaultActionIdentifier:
            // User tapped "Play" or the notification itself
            // Post notification to navigate to article and play
            NotificationCenter.default.post(
                name: .playArticleFromNotification,
                object: nil,
                userInfo: ["articleId": articleId]
            )
            logger.info("User requested to play article from notification: \(articleId)")

        case Action.dismiss.rawValue:
            logger.info("User dismissed synthesis notification for article: \(articleId)")

        default:
            break
        }
    }

    @MainActor
    private func handleVoiceCloneNotificationAction(
        action: String,
        userInfo: [AnyHashable: Any]
    ) {
        guard let voiceId = userInfo["voiceId"] as? String else { return }

        switch action {
        case Action.play.rawValue, UNNotificationDefaultActionIdentifier:
            // User tapped "Play" or the notification itself
            // Post notification to preview the voice
            NotificationCenter.default.post(
                name: .previewVoiceFromNotification,
                object: nil,
                userInfo: ["voiceId": voiceId]
            )
            logger.info("User requested to preview voice from notification: \(voiceId)")

        case Action.dismiss.rawValue:
            logger.info("User dismissed voice clone notification for: \(voiceId)")

        default:
            break
        }
    }
}

// MARK: - Notification Names

extension Notification.Name {
    /// Posted when user taps a synthesis complete notification to play an article
    static let playArticleFromNotification = Notification.Name("playArticleFromNotification")

    /// Posted when user taps a voice clone ready notification to preview
    static let previewVoiceFromNotification = Notification.Name("previewVoiceFromNotification")
}
