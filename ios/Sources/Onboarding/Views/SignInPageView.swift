import SwiftUI
import AuthenticationServices

// MARK: - Sign In Page View

/// Optional sign-in page shown after paywall during onboarding.
/// Users can sign in with Apple/Google or continue without signing in.
struct SignInPageView: View {
    @ObservedObject private var manager = OnboardingManager.shared
    @ObservedObject private var authService = AuthService.shared

    @State private var isSigningIn = false
    @State private var showError = false
    @State private var errorMessage = ""

    var body: some View {
        VStack(spacing: 0) {
            // Skip button
            HStack {
                Spacer()

                Button {
                    manager.completeOnboarding()
                } label: {
                    Text("Skip")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Color(.secondarySystemBackground))
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)

            Spacer()

            // Content
            VStack(spacing: 32) {
                // Icon
                ZStack {
                    Circle()
                        .fill(Color.blue.opacity(0.1))
                        .frame(width: 100, height: 100)

                    Image(systemName: "person.circle.fill")
                        .font(.system(size: 50))
                        .foregroundStyle(.blue)
                }

                // Title and description
                VStack(spacing: 12) {
                    Text("Sign In (Optional)")
                        .font(.system(size: 26, weight: .bold))

                    Text("Sign in to unlock all features including voice sharing and cross-device sync.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 20)
                }

                // Benefits
                VStack(alignment: .leading, spacing: 16) {
                    BenefitItem(
                        icon: "mic.fill",
                        title: "Share Your Voice",
                        description: "Share cloned voices with the community"
                    )

                    BenefitItem(
                        icon: "person.2.fill",
                        title: "Community Voices",
                        description: "Use voices shared by others"
                    )

                    BenefitItem(
                        icon: "gift.fill",
                        title: "Earn Rewards",
                        description: "Get listening minutes when others use your voices"
                    )

                    BenefitItem(
                        icon: "icloud.fill",
                        title: "Sync Across Devices",
                        description: "Your data follows you everywhere"
                    )
                }
                .padding(.horizontal, 32)
            }

            Spacer()

            // Sign in buttons
            VStack(spacing: 12) {
                // Apple Sign In
                SignInWithAppleButton(
                    onRequest: { request in
                        request.requestedScopes = [.fullName, .email]
                    },
                    onCompletion: { _ in }
                )
                .signInWithAppleButtonStyle(.black)
                .frame(height: 50)
                .cornerRadius(12)
                .overlay {
                    Button {
                        Task { await signInWithApple() }
                    } label: {
                        Color.clear
                    }
                }

                // Continue without sign in
                Button {
                    manager.completeOnboarding()
                } label: {
                    Text("Continue Without Signing In")
                        .font(.subheadline)
                        .foregroundStyle(.blue)
                }
                .padding(.top, 8)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 32)
            .disabled(isSigningIn)
        }
        .overlay {
            if isSigningIn {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .overlay {
                        VStack(spacing: 12) {
                            ProgressView()
                                .scaleEffect(1.2)
                            Text("Signing in...")
                                .font(.subheadline)
                        }
                        .padding(24)
                        .background(Color(.systemBackground))
                        .cornerRadius(16)
                    }
            }
        }
        .alert("Sign In Error", isPresented: $showError) {
            Button("OK") {}
        } message: {
            Text(errorMessage)
        }
        .onChange(of: authService.isAuthenticated) { isAuthenticated in
            if isAuthenticated {
                manager.completeOnboarding()
            }
        }
    }

    // MARK: - Sign In Methods

    private func signInWithApple() async {
        isSigningIn = true
        defer { isSigningIn = false }

        do {
            try await authService.signInWithApple()
            try? await authService.linkDevice()
        } catch AuthError.userCancelled {
            // Don't show error for cancellation
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
    }
}

// MARK: - Benefit Item

private struct BenefitItem: View {
    let icon: String
    let title: String
    let description: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(.blue)
                .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))

                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Preview

#Preview {
    SignInPageView()
}
