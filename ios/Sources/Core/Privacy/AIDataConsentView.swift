import SwiftUI

// MARK: - AI Data Consent View

/// Disclosure and consent screen for third-party AI data sharing.
/// Used in onboarding (new users) and settings (review/revoke).
struct AIDataConsentView: View {
    let isOnboarding: Bool
    @ObservedObject private var consentManager = AIDataConsentManager.shared
    @Environment(\.dismiss) private var dismiss

    private let privacyURL = URL(string: "https://kreativekoala.llc/privacy")!

    var body: some View {
        ZStack {
            // Background gradient matching onboarding
            LinearGradient(
                colors: [Color(hex: "FFF8E7"), Color(hex: "FFF5E0"), .white],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                ScrollView {
                    VStack(spacing: 20) {
                        headerSection
                        disclosureCards
                        privacyLink
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 24)
                    .padding(.bottom, 16)
                }

                footerSection
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !isOnboarding {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .interactiveDismissDisabled(isOnboarding)
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: 12) {
            Image(systemName: "shield.lefthalf.filled")
                .font(.system(size: 48))
                .foregroundStyle(.blue)
                .padding(.bottom, 4)

            Text("Your Data & AI Services")
                .font(.title2.bold())
                .multilineTextAlignment(.center)

            Text("ReadAloud AI uses cloud-based AI services to convert your text to speech and provide content summaries. Here's exactly what data is shared and with whom.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    // MARK: - Disclosure Cards

    private var disclosureCards: some View {
        VStack(spacing: 12) {
            DataConsentDisclosureCard(
                icon: "waveform",
                iconColor: .blue,
                title: "Text-to-Speech",
                description: "When you use cloud voices, the text content of your articles is sent to our servers for audio generation.",
                services: [
                    (name: "Kokoro TTS", detail: "Standard quality (hosted on Google Cloud)"),
                    (name: "ElevenLabs", detail: "Premium quality voices")
                ]
            )

            DataConsentDisclosureCard(
                icon: "mic.fill",
                iconColor: .purple,
                title: "Voice Cloning",
                description: "When you create a voice clone, your voice recording and text content are sent to our servers for processing.",
                services: [
                    (name: "Chatterbox TTS", detail: "Voice cloning (hosted on Google Cloud)")
                ]
            )

            DataConsentDisclosureCard(
                icon: "text.magnifyingglass",
                iconColor: .orange,
                title: "AI Content Summaries",
                description: "When you request a summary, your article text is sent to OpenAI for processing.",
                services: [
                    (name: "OpenAI", detail: "GPT-4o-mini for summarization")
                ]
            )

            DataConsentDisclosureCard(
                icon: "lock.shield.fill",
                iconColor: .green,
                title: "What Stays on Your Device",
                description: "The following never leaves your device:",
                services: [
                    (name: "Apple on-device voices", detail: "No external data sharing"),
                    (name: "Your imported files", detail: "Stored locally"),
                    (name: "Reading history", detail: "Stays on device")
                ]
            )
        }
    }

    // MARK: - Privacy Link

    private var privacyLink: some View {
        VStack(spacing: 8) {
            Text("On-device Apple voices work without any data sharing. You can switch to on-device voices anytime in Settings.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Link("Read our full Privacy Policy", destination: privacyURL)
                .font(.caption.weight(.medium))
                .tint(.blue)
        }
    }

    // MARK: - Footer

    private var footerSection: some View {
        VStack(spacing: 12) {
            Divider()

            VStack(spacing: 12) {
                Button(action: handleAccept) {
                    Text("I Understand & Agree")
                }
                .buttonStyle(OnboardingPrimaryButtonStyle())

                if isOnboarding {
                    Button(action: handleDecline) {
                        Text("Use On-Device Voices Only")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                } else if consentManager.hasConsented {
                    Button(action: handleRevoke) {
                        Text("Revoke Consent")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.red)
                    }
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
            .padding(.top, 8)
        }
    }

    // MARK: - Actions

    private func handleAccept() {
        consentManager.grantConsent()
        if isOnboarding {
            let manager = OnboardingManager.shared
            if manager.isReturningUser {
                // Returning users already completed paywall/sign-in — go straight to app
                manager.completeOnboarding()
            } else {
                manager.nextPage()
            }
        } else {
            dismiss()
        }
    }

    private func handleDecline() {
        // Don't grant consent — user will be limited to on-device voices
        if isOnboarding {
            let manager = OnboardingManager.shared
            if manager.isReturningUser {
                // Returning users already completed paywall/sign-in — go straight to app
                manager.completeOnboarding()
            } else {
                manager.nextPage()
            }
        } else {
            dismiss()
        }
    }

    private func handleRevoke() {
        consentManager.revokeConsent()
        // Disable cloud access so TTS falls back to on-device
        TTSCoordinator.shared.setCloudAccessEnabled(false)
        dismiss()
    }
}

// MARK: - Disclosure Card

struct DataConsentDisclosureCard: View {
    let icon: String
    let iconColor: Color
    let title: String
    let description: String
    let services: [(name: String, detail: String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(iconColor)
                    .frame(width: 32, height: 32)
                Text(title)
                    .font(.headline)
            }

            Text(description)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            ForEach(Array(services.enumerated()), id: \.offset) { _, service in
                HStack(spacing: 8) {
                    Circle()
                        .fill(iconColor.opacity(0.3))
                        .frame(width: 6, height: 6)
                    Text(service.name)
                        .font(.caption.weight(.medium))
                    Text("— \(service.detail)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
