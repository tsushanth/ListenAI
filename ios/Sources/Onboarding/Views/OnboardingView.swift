import SwiftUI

// MARK: - Onboarding View

/// Main onboarding container with page-based navigation.
struct OnboardingView: View {
    @ObservedObject private var manager = OnboardingManager.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            // Background gradient
            LinearGradient(
                colors: [Color(hex: "FFF8E7"), Color(hex: "FFF5E0"), .white],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                // Current page content
                TabView(selection: $manager.currentPage) {
                    WelcomePageView()
                        .tag(OnboardingPage.welcome)

                    DocumentToAudioPageView()
                        .tag(OnboardingPage.documentToAudio)

                    TakeNotesPageView()
                        .tag(OnboardingPage.takeNotes)

                    ProductivityPageView()
                        .tag(OnboardingPage.productivity)

                    VoiceSelectionPageView()
                        .tag(OnboardingPage.voiceSelection)

                    PaywallPageView()
                        .tag(OnboardingPage.paywall)
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .animation(.easeInOut(duration: 0.3), value: manager.currentPage)
            }
        }
        .interactiveDismissDisabled()
    }
}

// MARK: - Onboarding Button Style

struct OnboardingPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
            .background(Color.black)
            .cornerRadius(16)
            .scaleEffect(configuration.isPressed ? 0.98 : 1.0)
            .animation(.easeInOut(duration: 0.1), value: configuration.isPressed)
    }
}

// MARK: - Footer View

struct OnboardingFooterView: View {
    let buttonTitle: String
    let action: () -> Void
    var showTerms: Bool = true

    private let privacyURL = URL(string: "https://kreativekoala.llc/privacy")!
    private let termsURL = URL(string: "https://kreativekoala.llc/terms")!

    var body: some View {
        VStack(spacing: 16) {
            Button(action: action) {
                Text(buttonTitle)
            }
            .buttonStyle(OnboardingPrimaryButtonStyle())
            .padding(.horizontal, 24)

            if showTerms {
                HStack(spacing: 4) {
                    Text("By continuing, you agree to our")
                        .foregroundStyle(.secondary)
                    Link("Privacy Policy", destination: privacyURL)
                        .foregroundStyle(.blue)
                    Text("and")
                        .foregroundStyle(.secondary)
                    Link("Terms of Use", destination: termsURL)
                        .foregroundStyle(.blue)
                    Text(".")
                        .foregroundStyle(.secondary)
                }
                .font(.caption)
            }
        }
        .padding(.bottom, 24)
    }
}

#Preview {
    OnboardingView()
}
