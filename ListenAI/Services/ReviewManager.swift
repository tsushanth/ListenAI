import Foundation
import StoreKit

/// Manages app review prompts using StoreKit
@MainActor
final class ReviewManager {
    static let shared = ReviewManager()

    private let userDefaults = UserDefaults.standard
    private let minimumLaunchCount = 3
    private let minimumSuccessfulActions = 1

    // UserDefaults keys
    private enum Keys {
        static let launchCount = "app_launch_count"
        static let lastReviewRequestDate = "last_review_request_date"
        static let successfulActionsCount = "successful_actions_count"
        static let hasCompletedFirstUserJourney = "has_completed_first_user_journey"
    }

    private init() {
        incrementLaunchCount()
    }

    /// Call this when the app launches
    func recordAppLaunch() {
        incrementLaunchCount()
        checkAndRequestReview()
    }

    /// Call this when the user completes a successful action (e.g., completes a task, finishes a game level, etc.)
    func recordSuccessfulAction() {
        let currentCount = userDefaults.integer(forKey: Keys.successfulActionsCount)
        userDefaults.set(currentCount + 1, forKey: Keys.successfulActionsCount)

        // Mark first user journey as complete
        if currentCount == 0 {
            userDefaults.set(true, forKey: Keys.hasCompletedFirstUserJourney)
        }

        checkAndRequestReview()
    }

    /// Manually request review (use sparingly)
    func requestReview() {
        guard let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene else {
            return
        }

        SKStoreReviewController.requestReview(in: scene)
        userDefaults.set(Date(), forKey: Keys.lastReviewRequestDate)
    }

    // MARK: - Private Methods

    private func incrementLaunchCount() {
        let currentCount = userDefaults.integer(forKey: Keys.launchCount)
        userDefaults.set(currentCount + 1, forKey: Keys.launchCount)
    }

    private func checkAndRequestReview() {
        guard shouldRequestReview() else { return }
        requestReview()
    }

    private func shouldRequestReview() -> Bool {
        // Check if user has completed at least one successful action
        let successfulActions = userDefaults.integer(forKey: Keys.successfulActionsCount)
        guard successfulActions >= minimumSuccessfulActions else {
            return false
        }

        // Check if user has launched the app enough times
        let launchCount = userDefaults.integer(forKey: Keys.launchCount)
        guard launchCount >= minimumLaunchCount else {
            return false
        }

        // Check if we've requested a review recently (wait at least 365 days between requests)
        if let lastRequestDate = userDefaults.object(forKey: Keys.lastReviewRequestDate) as? Date {
            let daysSinceLastRequest = Calendar.current.dateComponents([.day], from: lastRequestDate, to: Date()).day ?? 0
            guard daysSinceLastRequest >= 365 else {
                return false
            }
        }

        return true
    }

    // MARK: - Debug Helpers (Remove in production)

    #if DEBUG
    func resetReviewState() {
        userDefaults.removeObject(forKey: Keys.launchCount)
        userDefaults.removeObject(forKey: Keys.lastReviewRequestDate)
        userDefaults.removeObject(forKey: Keys.successfulActionsCount)
        userDefaults.removeObject(forKey: Keys.hasCompletedFirstUserJourney)
        print("ReviewManager: State reset for debugging")
    }

    func printDebugInfo() {
        print("ReviewManager Debug Info:")
        print("  Launch Count: \(userDefaults.integer(forKey: Keys.launchCount))")
        print("  Successful Actions: \(userDefaults.integer(forKey: Keys.successfulActionsCount))")
        print("  First Journey Complete: \(userDefaults.bool(forKey: Keys.hasCompletedFirstUserJourney))")
        if let lastDate = userDefaults.object(forKey: Keys.lastReviewRequestDate) as? Date {
            print("  Last Review Request: \(lastDate)")
        } else {
            print("  Last Review Request: Never")
        }
        print("  Should Request Review: \(shouldRequestReview())")
    }
    #endif
}

// MARK: - Usage Examples

/*

 ## In App Entry Point (App.swift or AppDelegate):

 ```swift
 import SwiftUI

 @main
 struct MyApp: App {
     init() {
         ReviewManager.shared.recordAppLaunch()
     }

     var body: some Scene {
         WindowGroup {
             ContentView()
         }
     }
 }
 ```

 ## After Successful User Action:

 ```swift
 // When user completes a task
 func completeTask() {
     // ... task completion logic
     ReviewManager.shared.recordSuccessfulAction()
 }

 // When user finishes a level
 func finishLevel() {
     // ... level completion logic
     ReviewManager.shared.recordSuccessfulAction()
 }

 // When user creates something
 func createItem() {
     // ... creation logic
     ReviewManager.shared.recordSuccessfulAction()
 }
 ```

 ## Debug Testing (in Debug builds only):

 ```swift
 #if DEBUG
 // Reset state to test review prompt
 ReviewManager.shared.resetReviewState()

 // Check current state
 ReviewManager.shared.printDebugInfo()
 #endif
 ```

 */
