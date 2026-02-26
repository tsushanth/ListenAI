import SwiftUI

// MARK: - Onboarding View

/// Main onboarding container with page-based navigation.
struct OnboardingView: View {
    @ObservedObject private var manager = OnboardingManager.shared
    @ObservedObject private var revenueCat = RevenueCatManager.shared
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

                    AIDataConsentView(isOnboarding: true)
                        .tag(OnboardingPage.dataConsent)

                    RemotePaywallView(triggerSource: "onboarding", isOnboarding: true)
                        .tag(OnboardingPage.paywall)

                    SignInPageView()
                        .tag(OnboardingPage.signIn)
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .animation(.easeInOut(duration: 0.3), value: manager.currentPage)
            }
        }
        .interactiveDismissDisabled()
        .onAppear {
            // Returning users (who already completed onboarding v1) skip straight to consent
            if manager.isReturningUser {
                manager.skipToDataConsent()
            }
        }
        .onChange(of: revenueCat.isPremium) { _, isPremium in
            // Auto-advance past paywall when user becomes premium
            if isPremium && manager.currentPage == .paywall {
                manager.nextPage()
            }
        }
        .onChange(of: manager.currentPage) { _, page in
            // Skip paywall if user is already premium
            if page == .paywall && revenueCat.isPremium {
                manager.nextPage()
            }
        }
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
                Text("By continuing, you agree to our [Privacy Policy](\(privacyURL)) and [Terms of Use](\(termsURL)).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .tint(.blue)
                    .padding(.horizontal, 24)
            }
        }
        .padding(.bottom, 24)
    }
}

#Preview {
    OnboardingView()
}
