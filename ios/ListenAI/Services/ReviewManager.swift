import Foundation
import StoreKit
import SwiftUI

/// Manages app review prompts with a two-step flow:
/// 1. Shows "Are you enjoying [AppName]?" dialog
/// 2. YES → StoreKit review prompt, NO → feedback email
@MainActor
final class ReviewManager: ObservableObject {
    static let shared = ReviewManager()

    @Published var showReviewPrompt = false

    private let userDefaults = UserDefaults.standard
    private let minimumLaunchCount = 3
    private let minimumSuccessfulActions = 1
    private let feedbackEmail = "support@kreativekoala.llc"

    private enum Keys {
        static let launchCount = "app_launch_count"
        static let lastReviewRequestDate = "last_review_request_date"
        static let successfulActionsCount = "successful_actions_count"
        static let hasCompletedFirstUserJourney = "has_completed_first_user_journey"
    }

    private init() {}

    /// Call this when the app launches
    func recordAppLaunch() {
        incrementLaunchCount()
    }

    /// Call this when the user completes a successful action
    func recordSuccessfulAction() {
        let currentCount = userDefaults.integer(forKey: Keys.successfulActionsCount)
        userDefaults.set(currentCount + 1, forKey: Keys.successfulActionsCount)

        if currentCount == 0 {
            userDefaults.set(true, forKey: Keys.hasCompletedFirstUserJourney)
        }

        if shouldRequestReview() {
            showReviewPrompt = true
        }
    }

    /// User tapped "Yes, I love it!" — show StoreKit review
    func handlePositiveResponse() {
        showReviewPrompt = false
        guard let scene = UIApplication.shared.connectedScenes
            .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene else { return }
        SKStoreReviewController.requestReview(in: scene)
        userDefaults.set(Date(), forKey: Keys.lastReviewRequestDate)
    }

    /// User tapped "Not really" — open feedback email
    func handleNegativeResponse() {
        showReviewPrompt = false
        userDefaults.set(Date(), forKey: Keys.lastReviewRequestDate)
        let appName = Self.appName
        let subject = "Feedback for \(appName)".addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        if let url = URL(string: "mailto:\(feedbackEmail)?subject=\(subject)") {
            UIApplication.shared.open(url)
        }
    }

    /// User tapped "Ask me later"
    func handleDismiss() {
        showReviewPrompt = false
    }

    // MARK: - Private

    private func incrementLaunchCount() {
        let currentCount = userDefaults.integer(forKey: Keys.launchCount)
        userDefaults.set(currentCount + 1, forKey: Keys.launchCount)
    }

    private func shouldRequestReview() -> Bool {
        let successfulActions = userDefaults.integer(forKey: Keys.successfulActionsCount)
        guard successfulActions >= minimumSuccessfulActions else { return false }

        let launchCount = userDefaults.integer(forKey: Keys.launchCount)
        guard launchCount >= minimumLaunchCount else { return false }

        if let lastRequestDate = userDefaults.object(forKey: Keys.lastReviewRequestDate) as? Date {
            let daysSinceLastRequest = Calendar.current.dateComponents([.day], from: lastRequestDate, to: Date()).day ?? 0
            guard daysSinceLastRequest >= 90 else { return false }
        }

        return true
    }

    static var appName: String {
        Bundle.main.infoDictionary?["CFBundleDisplayName"] as? String
            ?? Bundle.main.infoDictionary?["CFBundleName"] as? String
            ?? "this app"
    }

    #if DEBUG
    func resetReviewState() {
        userDefaults.removeObject(forKey: Keys.launchCount)
        userDefaults.removeObject(forKey: Keys.lastReviewRequestDate)
        userDefaults.removeObject(forKey: Keys.successfulActionsCount)
        userDefaults.removeObject(forKey: Keys.hasCompletedFirstUserJourney)
    }
    #endif
}

// MARK: - SwiftUI View Modifier

struct ReviewPromptModifier: ViewModifier {
    @ObservedObject var reviewManager = ReviewManager.shared

    func body(content: Content) -> some View {
        content
            .alert("Enjoying \(ReviewManager.appName)?", isPresented: $reviewManager.showReviewPrompt) {
                Button("Yes, I love it!") { reviewManager.handlePositiveResponse() }
                Button("Not really") { reviewManager.handleNegativeResponse() }
                Button("Ask me later", role: .cancel) { reviewManager.handleDismiss() }
            } message: {
                Text("Your feedback helps us improve!")
            }
    }
}

extension View {
    func reviewPrompt() -> some View {
        modifier(ReviewPromptModifier())
    }
}
