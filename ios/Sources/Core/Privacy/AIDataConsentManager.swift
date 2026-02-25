import Foundation
import SwiftUI

// MARK: - AI Data Consent Manager

/// Manages user consent state for sharing data with third-party AI services.
/// Consent is required before sending text to cloud TTS, voice cloning, or AI summarization.
@MainActor
final class AIDataConsentManager: ObservableObject {

    // MARK: - Singleton

    static let shared = AIDataConsentManager()

    // MARK: - Published State

    @Published private(set) var hasConsented: Bool
    @Published private(set) var consentDate: Date?
    @Published private(set) var consentVersion: Int

    // MARK: - Keys

    private enum Keys {
        static let hasConsented = "ai_data_consent_granted"
        static let consentDate = "ai_data_consent_date"
        static let consentVersion = "ai_data_consent_version"
    }

    /// Increment when the consent scope changes materially (e.g., adding a new third-party service).
    static let currentConsentVersion = 1

    // MARK: - Initialization

    private init() {
        let savedVersion = UserDefaults.standard.integer(forKey: Keys.consentVersion)
        let granted = UserDefaults.standard.bool(forKey: Keys.hasConsented)
        // Consent is only valid if the version matches or exceeds current
        self.hasConsented = granted && savedVersion >= Self.currentConsentVersion
        self.consentDate = UserDefaults.standard.object(forKey: Keys.consentDate) as? Date
        self.consentVersion = savedVersion
    }

    // MARK: - Actions

    func grantConsent() {
        hasConsented = true
        consentDate = Date()
        consentVersion = Self.currentConsentVersion
        UserDefaults.standard.set(true, forKey: Keys.hasConsented)
        UserDefaults.standard.set(Date(), forKey: Keys.consentDate)
        UserDefaults.standard.set(Self.currentConsentVersion, forKey: Keys.consentVersion)
    }

    func revokeConsent() {
        hasConsented = false
        consentDate = nil
        UserDefaults.standard.set(false, forKey: Keys.hasConsented)
        UserDefaults.standard.removeObject(forKey: Keys.consentDate)
    }

    /// Returns true if consent was never granted or was granted for an older version.
    var needsConsent: Bool {
        !hasConsented
    }
}
