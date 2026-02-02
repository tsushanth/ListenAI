import Foundation
import AuthenticationServices
import CryptoKit
import UIKit

// MARK: - Auth Service

/// Service for handling user authentication with Supabase via Apple Sign In and Google Sign In.
/// This provides app-wide authentication for features like Voice Marketplace.
@MainActor
final class AuthService: NSObject, ObservableObject {

    // MARK: - Singleton

    static let shared = AuthService()

    // MARK: - Published State

    @Published private(set) var isAuthenticated: Bool = false
    @Published private(set) var isLoading: Bool = false
    @Published private(set) var user: AuthUser?
    @Published private(set) var error: AuthError?

    // MARK: - Private Properties

    private var backendURL: URL?
    private var currentNonce: String?

    // Keychain keys
    private let accessTokenKey = "ListenAI.Auth.AccessToken"
    private let refreshTokenKey = "ListenAI.Auth.RefreshToken"
    private let tokenExpiryKey = "ListenAI.Auth.TokenExpiry"
    private let userKey = "ListenAI.Auth.User"

    // MARK: - Initialization

    private override init() {
        super.init()
        loadStoredSession()
    }

    // MARK: - Configuration

    /// Configure the auth service with the backend URL.
    func configure(backendURL: URL) {
        self.backendURL = backendURL
        print("[AuthService] Configured with backend: \(backendURL)")
    }

    // MARK: - Apple Sign In

    /// Sign in with Apple.
    /// Presents the Apple Sign In sheet and exchanges the credential with the backend.
    func signInWithApple() async throws {
        guard let backendURL = backendURL else {
            throw AuthError.notConfigured
        }

        isLoading = true
        error = nil
        defer { isLoading = false }

        // Generate nonce for replay attack prevention
        let nonce = randomNonceString()
        currentNonce = nonce
        let hashedNonce = sha256(nonce)

        // Create Apple ID request
        let appleIDProvider = ASAuthorizationAppleIDProvider()
        let request = appleIDProvider.createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = hashedNonce

        // Present sign-in UI
        let result = try await performAppleSignIn(request: request)

        // Extract credential
        guard let appleIDCredential = result.credential as? ASAuthorizationAppleIDCredential,
              let identityTokenData = appleIDCredential.identityToken,
              let identityToken = String(data: identityTokenData, encoding: .utf8) else {
            throw AuthError.invalidCredential
        }

        // Build user info from Apple (only available on first sign-in)
        var userInfo: [String: Any]?
        if let email = appleIDCredential.email {
            userInfo = [
                "email": email,
                "given_name": appleIDCredential.fullName?.givenName ?? "",
                "family_name": appleIDCredential.fullName?.familyName ?? ""
            ]
        }

        // Exchange with backend
        try await exchangeAppleToken(
            backendURL: backendURL,
            idToken: identityToken,
            nonce: nonce,
            user: userInfo
        )

        print("[AuthService] Apple Sign In successful for \(user?.email ?? "unknown")")
    }

    // MARK: - Session Management

    /// Get a valid access token, refreshing if needed.
    func getAccessToken() async throws -> String {
        guard isAuthenticated else {
            throw AuthError.notAuthenticated
        }

        // Check if token is expired
        let expiry = UserDefaults.standard.double(forKey: tokenExpiryKey)
        if Date().timeIntervalSince1970 > expiry - 300 { // Refresh 5 min before expiry
            try await refreshSession()
        }

        guard let token = loadFromKeychain(key: accessTokenKey) else {
            throw AuthError.noAccessToken
        }

        return token
    }

    /// Get the current user's ID, or the device ID if not authenticated.
    func getCurrentUserId() -> String {
        if let userId = user?.id {
            return userId
        }
        // Fall back to device ID
        return getDeviceId()
    }

    /// Sign out the current user.
    func signOut() async {
        guard let backendURL = backendURL else {
            clearSession()
            return
        }

        // Notify backend (best-effort)
        if let token = loadFromKeychain(key: accessTokenKey) {
            var request = URLRequest(url: backendURL.appendingPathComponent("/api/auth/sign-out"))
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue(getDeviceId(), forHTTPHeaderField: "X-Device-ID")

            try? await URLSession.shared.data(for: request)
        }

        clearSession()
        print("[AuthService] Signed out")
    }

    /// Check if the user is signed in (has valid session).
    var isSignedIn: Bool {
        return isAuthenticated && user != nil
    }

    // MARK: - Device Linking

    /// Link the current device to the authenticated user.
    /// This migrates any data created while anonymous to the authenticated account.
    func linkDevice() async throws {
        guard let backendURL = backendURL, isAuthenticated else {
            return
        }

        guard let token = loadFromKeychain(key: accessTokenKey) else {
            throw AuthError.noAccessToken
        }

        var request = URLRequest(url: backendURL.appendingPathComponent("/api/auth/link-device"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(getDeviceId(), forHTTPHeaderField: "X-Device-ID")

        let body = ["device_id": getDeviceId()]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            print("[AuthService] Device link failed")
            return
        }

        print("[AuthService] Device linked successfully")
    }

    // MARK: - Private Methods

    private func performAppleSignIn(request: ASAuthorizationAppleIDRequest) async throws -> ASAuthorization {
        return try await withCheckedThrowingContinuation { continuation in
            let controller = ASAuthorizationController(authorizationRequests: [request])
            let delegate = AppleSignInDelegate(continuation: continuation)

            // Keep delegate alive
            objc_setAssociatedObject(controller, "delegate", delegate, .OBJC_ASSOCIATION_RETAIN)

            controller.delegate = delegate
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    private func exchangeAppleToken(
        backendURL: URL,
        idToken: String,
        nonce: String,
        user: [String: Any]?
    ) async throws {
        var request = URLRequest(url: backendURL.appendingPathComponent("/api/auth/apple"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(getDeviceId(), forHTTPHeaderField: "X-Device-ID")

        var body: [String: Any] = [
            "id_token": idToken,
            "nonce": nonce
        ]
        if let user = user {
            body["user"] = user
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw AuthError.networkError
        }

        if httpResponse.statusCode != 200 {
            if let errorResponse = try? JSONDecoder().decode(AuthErrorResponse.self, from: data) {
                throw AuthError.serverError(errorResponse.message)
            }
            throw AuthError.serverError("Authentication failed")
        }

        let authResponse = try JSONDecoder().decode(AuthResponse.self, from: data)
        saveSession(authResponse)
    }

    private func refreshSession() async throws {
        guard let backendURL = backendURL,
              let refreshToken = loadFromKeychain(key: refreshTokenKey) else {
            throw AuthError.noRefreshToken
        }

        var request = URLRequest(url: backendURL.appendingPathComponent("/api/auth/refresh"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body = ["refresh_token": refreshToken]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            // Refresh failed, clear session
            clearSession()
            throw AuthError.sessionExpired
        }

        let tokenResponse = try JSONDecoder().decode(TokenRefreshResponse.self, from: data)

        // Update tokens
        saveToKeychain(key: accessTokenKey, value: tokenResponse.accessToken)
        saveToKeychain(key: refreshTokenKey, value: tokenResponse.refreshToken)
        UserDefaults.standard.set(tokenResponse.expiresAt, forKey: tokenExpiryKey)

        print("[AuthService] Session refreshed")
    }

    private func saveSession(_ response: AuthResponse) {
        // Save tokens
        saveToKeychain(key: accessTokenKey, value: response.session.accessToken)
        saveToKeychain(key: refreshTokenKey, value: response.session.refreshToken)
        UserDefaults.standard.set(response.session.expiresAt, forKey: tokenExpiryKey)

        // Save user
        user = response.user
        if let userData = try? JSONEncoder().encode(response.user) {
            UserDefaults.standard.set(userData, forKey: userKey)
        }

        isAuthenticated = true
    }

    private func loadStoredSession() {
        // Check for stored tokens
        guard loadFromKeychain(key: accessTokenKey) != nil else {
            return
        }

        // Check if expired
        let expiry = UserDefaults.standard.double(forKey: tokenExpiryKey)
        if Date().timeIntervalSince1970 > expiry {
            // Token expired, but we have refresh token - mark as authenticated
            // Will refresh on next request
            if loadFromKeychain(key: refreshTokenKey) != nil {
                isAuthenticated = true
            }
        } else {
            isAuthenticated = true
        }

        // Load user
        if let userData = UserDefaults.standard.data(forKey: userKey),
           let storedUser = try? JSONDecoder().decode(AuthUser.self, from: userData) {
            user = storedUser
        }

        if isAuthenticated {
            print("[AuthService] Loaded stored session for \(user?.email ?? "unknown")")
        }
    }

    private func clearSession() {
        deleteFromKeychain(key: accessTokenKey)
        deleteFromKeychain(key: refreshTokenKey)
        UserDefaults.standard.removeObject(forKey: tokenExpiryKey)
        UserDefaults.standard.removeObject(forKey: userKey)

        isAuthenticated = false
        user = nil
    }

    // MARK: - Device ID

    private func getDeviceId() -> String {
        let key = "ListenAI.DeviceID"
        if let storedId = UserDefaults.standard.string(forKey: key) {
            return storedId
        }

        // Generate new device ID
        let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        UserDefaults.standard.set(deviceId, forKey: key)
        return deviceId
    }

    // MARK: - Crypto Helpers

    private func randomNonceString(length: Int = 32) -> String {
        precondition(length > 0)
        var randomBytes = [UInt8](repeating: 0, count: length)
        let errorCode = SecRandomCopyBytes(kSecRandomDefault, randomBytes.count, &randomBytes)
        if errorCode != errSecSuccess {
            fatalError("Unable to generate nonce. SecRandomCopyBytes failed with OSStatus \(errorCode)")
        }

        let charset: [Character] = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        let nonce = randomBytes.map { byte in
            charset[Int(byte) % charset.count]
        }

        return String(nonce)
    }

    private func sha256(_ input: String) -> String {
        let inputData = Data(input.utf8)
        let hashedData = SHA256.hash(data: inputData)
        let hashString = hashedData.compactMap {
            String(format: "%02x", $0)
        }.joined()

        return hashString
    }

    // MARK: - Keychain Helpers

    private func saveToKeychain(key: String, value: String) {
        let data = value.data(using: .utf8)!

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecValueData as String: data
        ]

        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }

    private func loadFromKeychain(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            return nil
        }

        return value
    }

    private func deleteFromKeychain(key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - ASAuthorizationControllerPresentationContextProviding

extension AuthService: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let window = scene.windows.first else {
            return ASPresentationAnchor()
        }
        return window
    }
}

// MARK: - ASWebAuthenticationPresentationContextProviding

extension AuthService: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let window = scene.windows.first else {
            return ASPresentationAnchor()
        }
        return window
    }
}

// MARK: - Apple Sign In Delegate

private class AppleSignInDelegate: NSObject, ASAuthorizationControllerDelegate {
    let continuation: CheckedContinuation<ASAuthorization, Error>

    init(continuation: CheckedContinuation<ASAuthorization, Error>) {
        self.continuation = continuation
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        continuation.resume(returning: authorization)
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        if let authError = error as? ASAuthorizationError {
            switch authError.code {
            case .canceled:
                continuation.resume(throwing: AuthError.userCancelled)
            case .invalidResponse:
                continuation.resume(throwing: AuthError.invalidResponse)
            default:
                continuation.resume(throwing: AuthError.appleSignInFailed(authError.localizedDescription))
            }
        } else {
            continuation.resume(throwing: AuthError.appleSignInFailed(error.localizedDescription))
        }
    }
}

// MARK: - Models

struct AuthUser: Codable, Equatable {
    let id: String
    let email: String?
    let displayName: String?
    let avatarURL: String?
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case email
        case displayName = "display_name"
        case avatarURL = "avatar_url"
        case createdAt = "created_at"
    }
}

struct AuthSession: Codable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Double

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresAt = "expires_at"
    }
}

struct AuthResponse: Codable {
    let user: AuthUser
    let session: AuthSession
}

struct TokenRefreshResponse: Codable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Double

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresAt = "expires_at"
    }
}

struct AuthErrorResponse: Codable {
    let error: String
    let message: String
}

// MARK: - Auth Error

enum AuthError: LocalizedError {
    case notConfigured
    case userCancelled
    case invalidCredential
    case invalidResponse
    case appleSignInFailed(String)
    case googleSignInFailed(String)
    case networkError
    case serverError(String)
    case notAuthenticated
    case noAccessToken
    case noRefreshToken
    case sessionExpired

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Auth service not configured"
        case .userCancelled:
            return "Sign-in was cancelled"
        case .invalidCredential:
            return "Invalid credential received"
        case .invalidResponse:
            return "Invalid response from authentication"
        case .appleSignInFailed(let message):
            return "Apple Sign In failed: \(message)"
        case .googleSignInFailed(let message):
            return "Google Sign In failed: \(message)"
        case .networkError:
            return "Network error occurred"
        case .serverError(let message):
            return message
        case .notAuthenticated:
            return "Not signed in"
        case .noAccessToken:
            return "No access token available"
        case .noRefreshToken:
            return "No refresh token available"
        case .sessionExpired:
            return "Session expired. Please sign in again."
        }
    }
}
