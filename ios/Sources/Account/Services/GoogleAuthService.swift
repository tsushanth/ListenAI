import Foundation
import AuthenticationServices
import CryptoKit

// MARK: - Google Auth Service

/// Service for handling Google OAuth authentication and Gmail API access.
@MainActor
final class GoogleAuthService: NSObject, ObservableObject {

    // MARK: - Published State

    @Published private(set) var isAuthenticated: Bool = false
    @Published private(set) var userEmail: String?
    @Published private(set) var userName: String?
    @Published private(set) var userAvatarURL: URL?
    @Published private(set) var isLoading: Bool = false
    @Published private(set) var error: GoogleAuthError?

    // MARK: - Private Properties

    private let clientID = "517355381306-iiuf6umqhie29ii0rnrd0shtb4e1ou5i.apps.googleusercontent.com"
    private let redirectURI = "com.googleusercontent.apps.517355381306-iiuf6umqhie29ii0rnrd0shtb4e1ou5i:/oauth2redirect"

    // OAuth endpoints
    private let authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth"
    private let tokenEndpoint = "https://oauth2.googleapis.com/token"
    private let userInfoEndpoint = "https://www.googleapis.com/oauth2/v3/userinfo"

    // Scopes for Gmail access
    private let scopes = [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.modify"
    ]

    // Token storage keys
    private let accessTokenKey = "ListenAI.Google.AccessToken"
    private let refreshTokenKey = "ListenAI.Google.RefreshToken"
    private let tokenExpiryKey = "ListenAI.Google.TokenExpiry"
    private let userEmailKey = "ListenAI.Google.UserEmail"
    private let userNameKey = "ListenAI.Google.UserName"

    // PKCE
    private var codeVerifier: String?
    private var authSession: ASWebAuthenticationSession?

    // MARK: - Singleton

    static let shared = GoogleAuthService()

    // MARK: - Initialization

    private override init() {
        super.init()
        loadStoredCredentials()
    }

    // MARK: - Public Methods

    /// Sign in with Google using OAuth 2.0 with PKCE
    func signIn() async throws {
        isLoading = true
        error = nil

        defer { isLoading = false }

        // Generate PKCE code verifier and challenge
        let verifier = generateCodeVerifier()
        codeVerifier = verifier
        let challenge = generateCodeChallenge(from: verifier)

        // Build authorization URL
        var components = URLComponents(string: authorizationEndpoint)!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: scopes.joined(separator: " ")),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "access_type", value: "offline"),
            URLQueryItem(name: "prompt", value: "consent")
        ]

        guard let authURL = components.url else {
            throw GoogleAuthError.invalidURL
        }

        // Present authentication session
        let callbackURL = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            let session = ASWebAuthenticationSession(
                url: authURL,
                callbackURLScheme: "com.googleusercontent.apps.517355381306-iiuf6umqhie29ii0rnrd0shtb4e1ou5i"
            ) { callbackURL, error in
                if let error = error {
                    if (error as NSError).code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        continuation.resume(throwing: GoogleAuthError.userCancelled)
                    } else {
                        continuation.resume(throwing: GoogleAuthError.authenticationFailed(error.localizedDescription))
                    }
                    return
                }

                guard let callbackURL = callbackURL else {
                    continuation.resume(throwing: GoogleAuthError.noCallbackURL)
                    return
                }

                continuation.resume(returning: callbackURL)
            }

            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = self

            self.authSession = session

            DispatchQueue.main.async {
                session.start()
            }
        }

        // Extract authorization code from callback URL
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value else {
            throw GoogleAuthError.noAuthorizationCode
        }

        // Exchange code for tokens
        try await exchangeCodeForTokens(code: code)

        // Fetch user info
        try await fetchUserInfo()

        isAuthenticated = true
        print("[GoogleAuth] Successfully signed in as \(userEmail ?? "unknown")")
    }

    /// Sign out and clear credentials
    func signOut() {
        // Clear stored credentials
        UserDefaults.standard.removeObject(forKey: accessTokenKey)
        UserDefaults.standard.removeObject(forKey: refreshTokenKey)
        UserDefaults.standard.removeObject(forKey: tokenExpiryKey)
        UserDefaults.standard.removeObject(forKey: userEmailKey)
        UserDefaults.standard.removeObject(forKey: userNameKey)

        // Clear keychain
        deleteFromKeychain(key: accessTokenKey)
        deleteFromKeychain(key: refreshTokenKey)

        // Reset state
        isAuthenticated = false
        userEmail = nil
        userName = nil
        userAvatarURL = nil

        print("[GoogleAuth] Signed out")
    }

    /// Get valid access token, refreshing if needed
    func getAccessToken() async throws -> String {
        guard isAuthenticated else {
            throw GoogleAuthError.notAuthenticated
        }

        // Check if token is expired
        let expiry = UserDefaults.standard.double(forKey: tokenExpiryKey)
        if Date().timeIntervalSince1970 > expiry - 300 { // Refresh 5 min before expiry
            try await refreshAccessToken()
        }

        guard let token = loadFromKeychain(key: accessTokenKey) else {
            throw GoogleAuthError.noAccessToken
        }

        return token
    }

    // MARK: - Private Methods

    private func loadStoredCredentials() {
        // Check if we have stored credentials
        if let email = UserDefaults.standard.string(forKey: userEmailKey),
           loadFromKeychain(key: accessTokenKey) != nil {
            isAuthenticated = true
            userEmail = email
            userName = UserDefaults.standard.string(forKey: userNameKey)
            print("[GoogleAuth] Loaded stored credentials for \(email)")
        }
    }

    private func exchangeCodeForTokens(code: String) async throws {
        guard let verifier = codeVerifier else {
            throw GoogleAuthError.noCodeVerifier
        }

        var request = URLRequest(url: URL(string: tokenEndpoint)!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        let body = [
            "client_id": clientID,
            "code": code,
            "code_verifier": verifier,
            "grant_type": "authorization_code",
            "redirect_uri": redirectURI
        ]

        request.httpBody = body
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")" }
            .joined(separator: "&")
            .data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error"
            print("[GoogleAuth] Token exchange failed: \(errorBody)")
            throw GoogleAuthError.tokenExchangeFailed
        }

        let tokenResponse = try JSONDecoder().decode(TokenResponse.self, from: data)

        // Store tokens securely
        saveToKeychain(key: accessTokenKey, value: tokenResponse.accessToken)
        if let refreshToken = tokenResponse.refreshToken {
            saveToKeychain(key: refreshTokenKey, value: refreshToken)
        }

        // Store expiry time
        let expiryTime = Date().timeIntervalSince1970 + Double(tokenResponse.expiresIn)
        UserDefaults.standard.set(expiryTime, forKey: tokenExpiryKey)

        codeVerifier = nil
    }

    private func refreshAccessToken() async throws {
        guard let refreshToken = loadFromKeychain(key: refreshTokenKey) else {
            throw GoogleAuthError.noRefreshToken
        }

        var request = URLRequest(url: URL(string: tokenEndpoint)!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        let body = [
            "client_id": clientID,
            "refresh_token": refreshToken,
            "grant_type": "refresh_token"
        ]

        request.httpBody = body
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")" }
            .joined(separator: "&")
            .data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            // Refresh token might be revoked, need to re-authenticate
            signOut()
            throw GoogleAuthError.refreshFailed
        }

        let tokenResponse = try JSONDecoder().decode(TokenResponse.self, from: data)

        // Store new access token
        saveToKeychain(key: accessTokenKey, value: tokenResponse.accessToken)

        // Store new expiry time
        let expiryTime = Date().timeIntervalSince1970 + Double(tokenResponse.expiresIn)
        UserDefaults.standard.set(expiryTime, forKey: tokenExpiryKey)

        print("[GoogleAuth] Refreshed access token")
    }

    private func fetchUserInfo() async throws {
        // Get token directly from keychain since we just stored it
        // (can't use getAccessToken() here as isAuthenticated is not yet true)
        guard let token = loadFromKeychain(key: accessTokenKey) else {
            throw GoogleAuthError.noAccessToken
        }

        var request = URLRequest(url: URL(string: userInfoEndpoint)!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw GoogleAuthError.userInfoFailed
        }

        let userInfo = try JSONDecoder().decode(UserInfoResponse.self, from: data)

        userEmail = userInfo.email
        userName = userInfo.name
        if let picture = userInfo.picture {
            userAvatarURL = URL(string: picture)
        }

        // Store user info
        UserDefaults.standard.set(userInfo.email, forKey: userEmailKey)
        UserDefaults.standard.set(userInfo.name, forKey: userNameKey)
    }

    // MARK: - PKCE Helpers

    private func generateCodeVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func generateCodeChallenge(from verifier: String) -> String {
        let data = Data(verifier.utf8)
        let hash = SHA256.hash(data: data)
        return Data(hash).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: - Keychain Helpers

    private func saveToKeychain(key: String, value: String) {
        let data = value.data(using: .utf8)!

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecValueData as String: data
        ]

        // Delete existing item first
        SecItemDelete(query as CFDictionary)

        // Add new item
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

// MARK: - ASWebAuthenticationPresentationContextProviding

extension GoogleAuthService: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let window = scene.windows.first else {
            return ASPresentationAnchor()
        }
        return window
    }
}

// MARK: - Response Models

private struct TokenResponse: Decodable {
    let accessToken: String
    let refreshToken: String?
    let expiresIn: Int
    let tokenType: String

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
        case tokenType = "token_type"
    }
}

private struct UserInfoResponse: Decodable {
    let sub: String
    let email: String
    let emailVerified: Bool?
    let name: String?
    let picture: String?
    let givenName: String?
    let familyName: String?

    enum CodingKeys: String, CodingKey {
        case sub
        case email
        case emailVerified = "email_verified"
        case name
        case picture
        case givenName = "given_name"
        case familyName = "family_name"
    }
}

// MARK: - Google Auth Error

enum GoogleAuthError: LocalizedError {
    case invalidURL
    case userCancelled
    case authenticationFailed(String)
    case noCallbackURL
    case noAuthorizationCode
    case noCodeVerifier
    case tokenExchangeFailed
    case noRefreshToken
    case refreshFailed
    case notAuthenticated
    case noAccessToken
    case userInfoFailed

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid authorization URL"
        case .userCancelled:
            return "Sign-in was cancelled"
        case .authenticationFailed(let message):
            return "Authentication failed: \(message)"
        case .noCallbackURL:
            return "No callback URL received"
        case .noAuthorizationCode:
            return "No authorization code received"
        case .noCodeVerifier:
            return "Missing code verifier"
        case .tokenExchangeFailed:
            return "Failed to exchange code for tokens"
        case .noRefreshToken:
            return "No refresh token available"
        case .refreshFailed:
            return "Failed to refresh access token. Please sign in again."
        case .notAuthenticated:
            return "Not authenticated with Google"
        case .noAccessToken:
            return "No access token available"
        case .userInfoFailed:
            return "Failed to fetch user info"
        }
    }
}
