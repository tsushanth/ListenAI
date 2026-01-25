import StoreKit
import SwiftUI
import os.log

private let logger = Logger(subsystem: "com.listenai", category: "AppReview")

/// Service for managing App Store review prompts.
/// Uses a feedback flow: first asks if user is enjoying, then triggers native review if yes.
@MainActor
final class AppReviewService: ObservableObject {
    static let shared = AppReviewService()

    // MARK: - Keys for UserDefaults

    private enum Keys {
        static let lastReviewPromptDate = "appReview_lastPromptDate"
        static let reviewPromptCount = "appReview_promptCount"
        static let hasCompletedReview = "appReview_hasCompleted"
        static let hasCompletedSuccessfulJourney = "appReview_hasCompletedJourney"
    }

    // MARK: - Configuration

    /// Minimum days between review prompts
    private let minimumDaysBetweenPrompts = 30

    /// Maximum review prompts to show in app lifetime
    private let maxPrompts = 3

    // MARK: - Notifications

    /// Posted when the feedback prompt should be shown
    static let shouldShowFeedbackPromptNotification = Notification.Name("AppReviewService.shouldShowFeedbackPrompt")

    // MARK: - State

    @Published var showFeedbackPrompt = false

    private init() {}

    /// Check and trigger feedback prompt if appropriate (posts notification if should show)
    func checkAndTriggerFeedbackPrompt() {
        if shouldShowFeedbackPrompt() {
            recordFeedbackPromptShown()
            NotificationCenter.default.post(name: Self.shouldShowFeedbackPromptNotification, object: nil)
            logger.info("Posted feedback prompt notification")
        }
    }

    // MARK: - Public API

    /// Call this after a successful voice clone creation
    func recordVoiceCloneSuccess() {
        UserDefaults.standard.set(true, forKey: Keys.hasCompletedSuccessfulJourney)
        logger.info("Voice clone success recorded - user journey complete")
    }

    /// Call this after first successful TTS playback completion
    func recordTTSPlaybackSuccess() {
        UserDefaults.standard.set(true, forKey: Keys.hasCompletedSuccessfulJourney)
        logger.info("TTS playback success recorded - user journey complete")
    }

    /// Check if we should show the feedback prompt
    func shouldShowFeedbackPrompt() -> Bool {
        // Don't show if user has already completed a review
        if UserDefaults.standard.bool(forKey: Keys.hasCompletedReview) {
            logger.debug("Skipping feedback: user has completed review")
            return false
        }

        // Don't show if we've reached max prompts
        let promptCount = UserDefaults.standard.integer(forKey: Keys.reviewPromptCount)
        if promptCount >= maxPrompts {
            logger.debug("Skipping feedback: max prompts reached (\(promptCount))")
            return false
        }

        // Check if enough time has passed since last prompt
        if let lastPromptDate = UserDefaults.standard.object(forKey: Keys.lastReviewPromptDate) as? Date {
            let daysSinceLastPrompt = Calendar.current.dateComponents([.day], from: lastPromptDate, to: Date()).day ?? 0
            if daysSinceLastPrompt < minimumDaysBetweenPrompts {
                logger.debug("Skipping feedback: only \(daysSinceLastPrompt) days since last prompt")
                return false
            }
        }

        // Check if user has completed at least one successful journey (voice clone OR TTS playback)
        if !UserDefaults.standard.bool(forKey: Keys.hasCompletedSuccessfulJourney) {
            logger.debug("Skipping feedback: no successful journey completed yet")
            return false
        }

        logger.info("Should show feedback prompt")
        return true
    }

    /// Record that we showed a feedback prompt
    func recordFeedbackPromptShown() {
        let promptCount = UserDefaults.standard.integer(forKey: Keys.reviewPromptCount)
        UserDefaults.standard.set(promptCount + 1, forKey: Keys.reviewPromptCount)
        UserDefaults.standard.set(Date(), forKey: Keys.lastReviewPromptDate)
        logger.info("Feedback prompt shown. Total prompts: \(promptCount + 1)")
    }

    /// User responded positively - trigger native App Store review
    func requestAppStoreReview() {
        logger.info("User enjoying app - requesting App Store review")

        // Mark as completed so we don't ask again
        UserDefaults.standard.set(true, forKey: Keys.hasCompletedReview)

        // Request the native App Store review
        if let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene {
            SKStoreReviewController.requestReview(in: scene)
        }
    }

    /// User responded negatively - could open feedback form in future
    func userNotEnjoying() {
        logger.info("User not enjoying - skipping review request")
        // Just record we asked and don't prompt again for a while
        // In future, could open a feedback form here
    }
}

// MARK: - Feedback Prompt View

/// Simple "Are you enjoying?" prompt that appears before triggering App Store review
struct FeedbackPromptView: View {
    let onYes: () -> Void
    let onNo: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 24) {
            // Icon
            Image(systemName: "heart.fill")
                .font(.system(size: 48))
                .foregroundStyle(.pink)

            // Title
            Text("Enjoying ReadAloud?")
                .font(.title2.bold())
                .foregroundStyle(.primary)

            // Subtitle
            Text("Your feedback helps us improve the app for everyone.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)

            // Buttons
            HStack(spacing: 16) {
                // No button
                Button {
                    onNo()
                    dismiss()
                } label: {
                    Text("Not Really")
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color(.systemGray5))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }

                // Yes button
                Button {
                    onYes()
                    dismiss()
                } label: {
                    Text("Yes!")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color.black)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(.horizontal, 24)
        }
        .padding(.vertical, 32)
        .background(Color(.systemBackground))
    }
}

#Preview {
    FeedbackPromptView(
        onYes: { print("Yes tapped") },
        onNo: { print("No tapped") }
    )
}
