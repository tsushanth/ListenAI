import Foundation
import SwiftUI

// MARK: - Onboarding Manager

/// Manages onboarding state and completion tracking for ReadAloud AI.
@MainActor
final class OnboardingManager: ObservableObject {

    // MARK: - Published State

    @Published var hasCompletedOnboarding: Bool {
        didSet {
            UserDefaults.standard.set(hasCompletedOnboarding, forKey: Keys.hasCompletedOnboarding)
        }
    }

    @Published var selectedVoiceId: String? {
        didSet {
            if let id = selectedVoiceId {
                UserDefaults.standard.set(id, forKey: Keys.selectedVoiceId)
            }
        }
    }

    @Published var currentPage: OnboardingPage = .welcome

    // MARK: - Singleton

    static let shared = OnboardingManager()

    // MARK: - Keys

    private enum Keys {
        static let hasCompletedOnboarding = "hasCompletedOnboarding"
        static let selectedVoiceId = "onboardingSelectedVoiceId"
        static let onboardingVersion = "onboardingVersion"
    }

    // Current onboarding version - increment to show onboarding again
    private let currentVersion = 1

    // MARK: - Initialization

    private init() {
        let savedVersion = UserDefaults.standard.integer(forKey: Keys.onboardingVersion)
        let hasCompleted = UserDefaults.standard.bool(forKey: Keys.hasCompletedOnboarding)

        // Show onboarding if never completed or if version changed
        self.hasCompletedOnboarding = hasCompleted && savedVersion >= currentVersion
        self.selectedVoiceId = UserDefaults.standard.string(forKey: Keys.selectedVoiceId)
    }

    // MARK: - Actions

    func completeOnboarding() {
        UserDefaults.standard.set(currentVersion, forKey: Keys.onboardingVersion)
        hasCompletedOnboarding = true
    }

    func resetOnboarding() {
        hasCompletedOnboarding = false
        selectedVoiceId = nil
        currentPage = .welcome
    }

    func nextPage() {
        if let next = currentPage.next {
            withAnimation(.easeInOut(duration: 0.3)) {
                currentPage = next
            }
        }
    }

    func previousPage() {
        if let previous = currentPage.previous {
            withAnimation(.easeInOut(duration: 0.3)) {
                currentPage = previous
            }
        }
    }

    func skipToPaywall() {
        withAnimation(.easeInOut(duration: 0.3)) {
            currentPage = .paywall
        }
    }
}

// MARK: - Onboarding Page

enum OnboardingPage: Int, CaseIterable {
    case welcome = 0
    case documentToAudio = 1
    case takeNotes = 2
    case productivity = 3
    case voiceSelection = 4
    case paywall = 5

    var next: OnboardingPage? {
        OnboardingPage(rawValue: rawValue + 1)
    }

    var previous: OnboardingPage? {
        OnboardingPage(rawValue: rawValue - 1)
    }

    var isFirst: Bool {
        self == .welcome
    }

    var isLast: Bool {
        self == .paywall
    }

    var showsBackButton: Bool {
        !isFirst && self != .paywall
    }

    var showsSkipButton: Bool {
        self != .paywall && self != .voiceSelection
    }
}
