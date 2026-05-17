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

    /// True when a returning user needs to see the data consent page only (not full onboarding).
    @Published var isReturningUser: Bool = false

    // MARK: - Singleton

    static let shared = OnboardingManager()

    // MARK: - Keys

    private enum Keys {
        static let hasCompletedOnboarding = "hasCompletedOnboarding"
        static let selectedVoiceId = "onboardingSelectedVoiceId"
        static let onboardingVersion = "onboardingVersion"
    }

    // Current onboarding version - increment to show onboarding again
    // v1: original onboarding
    // v2: added AI data consent page
    private let currentVersion = 2

    // MARK: - Initialization

    private init() {
        let savedVersion = UserDefaults.standard.integer(forKey: Keys.onboardingVersion)
        let hasCompleted = UserDefaults.standard.bool(forKey: Keys.hasCompletedOnboarding)

        if hasCompleted && savedVersion < currentVersion {
            // User completed old version but not new — they need consent only
            self.isReturningUser = true
            self.hasCompletedOnboarding = false
        } else {
            // Show onboarding if never completed or if version changed
            self.hasCompletedOnboarding = hasCompleted && savedVersion >= currentVersion
        }
        self.selectedVoiceId = UserDefaults.standard.string(forKey: Keys.selectedVoiceId)
    }

    // MARK: - Actions

    func completeOnboarding() {
        UserDefaults.standard.set(currentVersion, forKey: Keys.onboardingVersion)
        hasCompletedOnboarding = true
        isReturningUser = false
    }

    func resetOnboarding() {
        hasCompletedOnboarding = false
        selectedVoiceId = nil
        currentPage = .welcome
        isReturningUser = false
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

    func skipToDataConsent() {
        withAnimation(.easeInOut(duration: 0.3)) {
            currentPage = .dataConsent
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
    case offlineAI = 5
    case dataConsent = 6
    case paywall = 7
    case signIn = 8

    /// Walk forward over `next`/`previous`, skipping pages that aren't
    /// available on this device. Used so ineligible devices never see the
    /// Offline AI screen.
    var next: OnboardingPage? {
        var candidate = OnboardingPage(rawValue: rawValue + 1)
        while let c = candidate, !c.isAvailableOnThisDevice {
            candidate = OnboardingPage(rawValue: c.rawValue + 1)
        }
        return candidate
    }

    var previous: OnboardingPage? {
        var candidate = OnboardingPage(rawValue: rawValue - 1)
        while let c = candidate, !c.isAvailableOnThisDevice {
            candidate = OnboardingPage(rawValue: c.rawValue - 1)
        }
        return candidate
    }

    /// Some pages are conditionally shown. Currently only `.offlineAI` —
    /// hidden on devices that can't run Kokoro 82M on-device.
    var isAvailableOnThisDevice: Bool {
        switch self {
        case .offlineAI:
            return KokoroModelManager.isDeviceEligible
        default:
            return true
        }
    }

    var isFirst: Bool {
        self == .welcome
    }

    var isLast: Bool {
        self == .signIn
    }

    var showsBackButton: Bool {
        !isFirst && self != .paywall && self != .signIn && self != .dataConsent
    }

    var showsSkipButton: Bool {
        self != .paywall && self != .voiceSelection && self != .signIn && self != .dataConsent && self != .offlineAI
    }
}
