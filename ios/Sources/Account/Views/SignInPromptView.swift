import SwiftUI
import AuthenticationServices

// MARK: - Sign In Prompt View

/// A reusable view that prompts users to sign in when they try to access features that require authentication.
/// Used for marketplace features like sharing voices and using shared voices.
struct SignInPromptView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var authService = AuthService.shared

    let title: String
    let message: String
    let onComplete: () -> Void
    let onSkip: (() -> Void)?

    @State private var isSigningIn = false
    @State private var showError = false
    @State private var errorMessage = ""

    init(
        title: String = "Sign In Required",
        message: String,
        onComplete: @escaping () -> Void,
        onSkip: (() -> Void)? = nil
    ) {
        self.title = title
        self.message = message
        self.onComplete = onComplete
        self.onSkip = onSkip
    }

    var body: some View {
        VStack(spacing: 24) {
            // Header
            VStack(spacing: 12) {
                Image(systemName: "person.circle.fill")
                    .font(.system(size: 60))
                    .foregroundStyle(.blue)

                Text(title)
                    .font(.title2.bold())

                Text(message)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }

            Spacer()

            // Sign in buttons
            VStack(spacing: 12) {
                // Apple Sign In
                SignInWithAppleButton(
                    onRequest: { request in
                        request.requestedScopes = [.fullName, .email]
                    },
                    onCompletion: { result in
                        // Apple Sign In button completion is handled differently
                        // We use our AuthService instead
                    }
                )
                .signInWithAppleButtonStyle(.black)
                .frame(height: 50)
                .cornerRadius(8)
                .overlay {
                    // Overlay a button to use our auth flow
                    Button {
                        Task { await signInWithApple() }
                    } label: {
                        Color.clear
                    }
                }

                // Skip option
                if let onSkip = onSkip {
                    Button("Continue without signing in") {
                        onSkip()
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
                }
            }
            .padding(.horizontal)
            .disabled(isSigningIn)

            // Benefits
            VStack(alignment: .leading, spacing: 8) {
                Text("Benefits of signing in:")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                BenefitRow(icon: "mic.fill", text: "Share your cloned voices")
                BenefitRow(icon: "person.2.fill", text: "Use voices from the community")
                BenefitRow(icon: "dollarsign.circle.fill", text: "Earn rewards when others use your voices")
                BenefitRow(icon: "icloud.fill", text: "Sync your data across devices")
            }
            .padding()
            .background(Color(.secondarySystemBackground))
            .cornerRadius(12)
            .padding(.horizontal)

            Spacer()
        }
        .padding(.top, 40)
        .overlay {
            if isSigningIn {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .overlay {
                        ProgressView()
                            .scaleEffect(1.5)
                            .tint(.white)
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
                onComplete()
            }
        }
    }

    // MARK: - Sign In Methods

    private func signInWithApple() async {
        isSigningIn = true
        defer { isSigningIn = false }

        do {
            try await authService.signInWithApple()
            // Link device data
            try? await authService.linkDevice()
            // onComplete will be called via onChange
        } catch AuthError.userCancelled {
            // User cancelled - don't show error
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
    }
}

// MARK: - Benefit Row

private struct BenefitRow: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.blue)
                .frame(width: 20)

            Text(text)
                .font(.caption)
                .foregroundStyle(.primary)
        }
    }
}

// MARK: - Sign In Required Modifier

/// A view modifier that shows a sign-in prompt when a condition is met.
struct SignInRequiredModifier: ViewModifier {
    @ObservedObject private var authService = AuthService.shared
    @Binding var isPresented: Bool
    let message: String
    let onComplete: () -> Void
    let allowSkip: Bool

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $isPresented) {
                SignInPromptView(
                    message: message,
                    onComplete: {
                        isPresented = false
                        onComplete()
                    },
                    onSkip: allowSkip ? {
                        isPresented = false
                    } : nil
                )
            }
    }
}

extension View {
    /// Shows a sign-in prompt sheet when the binding is true.
    func signInRequired(
        isPresented: Binding<Bool>,
        message: String = "Sign in to continue",
        allowSkip: Bool = false,
        onComplete: @escaping () -> Void = {}
    ) -> some View {
        modifier(SignInRequiredModifier(
            isPresented: isPresented,
            message: message,
            onComplete: onComplete,
            allowSkip: allowSkip
        ))
    }
}

// MARK: - Auth Guard

/// A view that shows content only when authenticated, otherwise shows sign-in prompt.
struct AuthGuard<Content: View>: View {
    @ObservedObject private var authService = AuthService.shared
    let message: String
    let allowSkip: Bool
    @ViewBuilder let content: () -> Content

    @State private var skipped = false

    init(
        message: String = "Sign in to access this feature",
        allowSkip: Bool = false,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.message = message
        self.allowSkip = allowSkip
        self.content = content
    }

    var body: some View {
        if authService.isAuthenticated || skipped {
            content()
        } else {
            SignInPromptView(
                message: message,
                onComplete: {},
                onSkip: allowSkip ? { skipped = true } : nil
            )
        }
    }
}

// MARK: - Preview

#Preview("Sign In Prompt") {
    SignInPromptView(
        message: "Sign in to share your voice with the community and earn rewards when others use it.",
        onComplete: { print("Signed in!") },
        onSkip: { print("Skipped") }
    )
}

#Preview("Auth Guard - Not Signed In") {
    AuthGuard(
        message: "Sign in to share your voice",
        allowSkip: true
    ) {
        Text("Protected Content")
    }
}
