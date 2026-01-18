import Foundation

// MARK: - Gmail Service

/// Service for fetching and managing Gmail messages.
@MainActor
final class GmailService: ObservableObject {

    // MARK: - Published State

    @Published private(set) var emails: [GmailMessage] = []
    @Published private(set) var isLoading: Bool = false
    @Published private(set) var error: GmailError?
    @Published private(set) var hasMorePages: Bool = true

    // MARK: - Private Properties

    private let baseURL = "https://gmail.googleapis.com/gmail/v1"
    private let authService = GoogleAuthService.shared
    private var nextPageToken: String?

    // MARK: - Singleton

    static let shared = GmailService()

    private init() {}

    // MARK: - Public Methods

    /// Fetch emails from Gmail inbox
    /// - Parameters:
    ///   - maxResults: Maximum number of emails to fetch (default 20)
    ///   - query: Optional search query (Gmail search syntax)
    ///   - refresh: If true, clears existing emails and starts fresh
    func fetchEmails(maxResults: Int = 20, query: String? = nil, refresh: Bool = false) async throws {
        guard authService.isAuthenticated else {
            throw GmailError.notAuthenticated
        }

        if refresh {
            emails = []
            nextPageToken = nil
            hasMorePages = true
        }

        guard hasMorePages else { return }

        isLoading = true
        error = nil

        defer { isLoading = false }

        let token = try await authService.getAccessToken()

        // Build URL for listing messages
        guard var components = URLComponents(string: "\(baseURL)/users/me/messages") else {
            throw GmailError.invalidResponse
        }
        var queryItems = [
            URLQueryItem(name: "maxResults", value: String(maxResults)),
            URLQueryItem(name: "labelIds", value: "INBOX")
        ]

        if let query = query, !query.isEmpty {
            queryItems.append(URLQueryItem(name: "q", value: query))
        }

        if let pageToken = nextPageToken {
            queryItems.append(URLQueryItem(name: "pageToken", value: pageToken))
        }

        components.queryItems = queryItems

        guard let url = components.url else {
            throw GmailError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw GmailError.invalidResponse
        }

        if httpResponse.statusCode == 401 {
            throw GmailError.unauthorized
        }

        guard httpResponse.statusCode == 200 else {
            let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error"
            print("[Gmail] List failed: \(errorBody)")
            throw GmailError.fetchFailed
        }

        let listResponse = try JSONDecoder().decode(MessageListResponse.self, from: data)

        nextPageToken = listResponse.nextPageToken
        hasMorePages = listResponse.nextPageToken != nil

        // Fetch full message details for each message ID
        guard let messages = listResponse.messages else {
            return
        }

        // Fetch message details in batches
        var newEmails: [GmailMessage] = []
        for message in messages {
            do {
                let fullMessage = try await fetchMessageDetails(messageId: message.id, token: token)
                newEmails.append(fullMessage)
            } catch {
                print("[Gmail] Failed to fetch message \(message.id): \(error)")
            }
        }

        emails.append(contentsOf: newEmails)
    }

    /// Fetch a single email's full content
    func fetchFullEmail(messageId: String) async throws -> GmailMessage {
        guard authService.isAuthenticated else {
            throw GmailError.notAuthenticated
        }

        let token = try await authService.getAccessToken()
        return try await fetchMessageDetails(messageId: messageId, token: token, format: "full")
    }

    /// Search emails with query
    func searchEmails(query: String) async throws {
        try await fetchEmails(query: query, refresh: true)
    }

    /// Load more emails (pagination)
    func loadMore() async throws {
        try await fetchEmails()
    }

    /// Clear cached emails
    func clearCache() {
        emails = []
        nextPageToken = nil
        hasMorePages = true
    }

    // MARK: - Private Methods

    private func fetchMessageDetails(messageId: String, token: String, format: String = "metadata") async throws -> GmailMessage {
        guard var components = URLComponents(string: "\(baseURL)/users/me/messages/\(messageId)") else {
            throw GmailError.fetchFailed
        }
        components.queryItems = [
            URLQueryItem(name: "format", value: format),
            URLQueryItem(name: "metadataHeaders", value: "From"),
            URLQueryItem(name: "metadataHeaders", value: "To"),
            URLQueryItem(name: "metadataHeaders", value: "Subject"),
            URLQueryItem(name: "metadataHeaders", value: "Date")
        ]

        guard let url = components.url else {
            throw GmailError.fetchFailed
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw GmailError.fetchFailed
        }

        let messageResponse = try JSONDecoder().decode(MessageResponse.self, from: data)
        return parseMessage(messageResponse)
    }

    private func parseMessage(_ response: MessageResponse) -> GmailMessage {
        var from = ""
        var to = ""
        var subject = ""
        var date = Date()

        // Extract headers
        if let headers = response.payload?.headers {
            for header in headers {
                switch header.name.lowercased() {
                case "from":
                    from = header.value
                case "to":
                    to = header.value
                case "subject":
                    subject = header.value
                case "date":
                    date = parseEmailDate(header.value) ?? Date()
                default:
                    break
                }
            }
        }

        // Extract body
        let body = extractBody(from: response.payload)
        let snippet = response.snippet ?? ""

        // Check if read (UNREAD label means not read)
        let isRead = !(response.labelIds?.contains("UNREAD") ?? false)

        // Check for attachments
        let hasAttachment = response.payload?.parts?.contains { $0.filename != nil && !($0.filename?.isEmpty ?? true) } ?? false

        return GmailMessage(
            id: response.id,
            threadId: response.threadId,
            from: from,
            to: to,
            subject: subject,
            snippet: snippet,
            body: body,
            date: date,
            isRead: isRead,
            hasAttachment: hasAttachment,
            labelIds: response.labelIds ?? []
        )
    }

    private func extractBody(from payload: MessagePayload?) -> String {
        guard let payload = payload else { return "" }

        // Try to get body from payload directly
        if let body = payload.body?.data {
            return decodeBase64URL(body)
        }

        // Check parts for text content
        if let parts = payload.parts {
            // Prefer text/plain, then text/html
            for part in parts {
                if part.mimeType == "text/plain", let data = part.body?.data {
                    return decodeBase64URL(data)
                }
            }

            for part in parts {
                if part.mimeType == "text/html", let data = part.body?.data {
                    let html = decodeBase64URL(data)
                    return stripHTML(html)
                }
            }

            // Recursively check nested parts (multipart/alternative)
            for part in parts {
                if let nestedParts = part.parts {
                    let nestedPayload = MessagePayload(
                        mimeType: part.mimeType,
                        headers: part.headers,
                        body: part.body,
                        parts: nestedParts,
                        filename: part.filename
                    )
                    let nestedBody = extractBody(from: nestedPayload)
                    if !nestedBody.isEmpty {
                        return nestedBody
                    }
                }
            }
        }

        return ""
    }

    private func decodeBase64URL(_ encoded: String) -> String {
        var base64 = encoded
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")

        // Add padding if needed
        let paddingLength = (4 - base64.count % 4) % 4
        base64 += String(repeating: "=", count: paddingLength)

        guard let data = Data(base64Encoded: base64),
              let string = String(data: data, encoding: .utf8) else {
            return ""
        }

        return string
    }

    private func stripHTML(_ html: String) -> String {
        // Remove HTML tags
        var result = html
            .replacingOccurrences(of: "<br>", with: "\n", options: .caseInsensitive)
            .replacingOccurrences(of: "<br/>", with: "\n", options: .caseInsensitive)
            .replacingOccurrences(of: "<br />", with: "\n", options: .caseInsensitive)
            .replacingOccurrences(of: "</p>", with: "\n\n", options: .caseInsensitive)
            .replacingOccurrences(of: "</div>", with: "\n", options: .caseInsensitive)

        // Remove all remaining HTML tags
        while let range = result.range(of: "<[^>]+>", options: .regularExpression) {
            result.removeSubrange(range)
        }

        // Decode HTML entities
        result = result
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")

        // Clean up whitespace
        let lines = result.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        return lines.joined(separator: "\n\n")
    }

    private func parseEmailDate(_ dateString: String) -> Date? {
        let formatters = [
            "EEE, d MMM yyyy HH:mm:ss Z",
            "d MMM yyyy HH:mm:ss Z",
            "EEE, d MMM yyyy HH:mm:ss z",
            "yyyy-MM-dd'T'HH:mm:ssZ"
        ]

        for format in formatters {
            let formatter = DateFormatter()
            formatter.dateFormat = format
            formatter.locale = Locale(identifier: "en_US_POSIX")
            if let date = formatter.date(from: dateString) {
                return date
            }
        }

        return nil
    }
}

// MARK: - Gmail Message Model

struct GmailMessage: Identifiable, Equatable {
    let id: String
    let threadId: String
    let from: String
    let to: String
    let subject: String
    let snippet: String
    let body: String
    let date: Date
    let isRead: Bool
    let hasAttachment: Bool
    let labelIds: [String]

    /// Sender name extracted from "Name <email>" format
    var senderName: String {
        if let range = from.range(of: "<") {
            return String(from[..<range.lowerBound]).trimmingCharacters(in: .whitespaces)
        }
        return from
    }

    /// Sender email extracted from "Name <email>" format
    var senderEmail: String {
        if let startRange = from.range(of: "<"),
           let endRange = from.range(of: ">") {
            return String(from[startRange.upperBound..<endRange.lowerBound])
        }
        return from
    }
}

// MARK: - API Response Models

private struct MessageListResponse: Decodable {
    let messages: [MessageRef]?
    let nextPageToken: String?
    let resultSizeEstimate: Int?
}

private struct MessageRef: Decodable {
    let id: String
    let threadId: String
}

private struct MessageResponse: Decodable {
    let id: String
    let threadId: String
    let labelIds: [String]?
    let snippet: String?
    let payload: MessagePayload?
    let internalDate: String?
}

private struct MessagePayload: Decodable {
    let mimeType: String?
    let headers: [MessageHeader]?
    let body: MessageBody?
    let parts: [MessagePart]?
    let filename: String?
}

private struct MessageHeader: Decodable {
    let name: String
    let value: String
}

private struct MessageBody: Decodable {
    let size: Int?
    let data: String?
    let attachmentId: String?
}

private struct MessagePart: Decodable {
    let partId: String?
    let mimeType: String?
    let filename: String?
    let headers: [MessageHeader]?
    let body: MessageBody?
    let parts: [MessagePart]?
}

// MARK: - Gmail Error

enum GmailError: LocalizedError {
    case notAuthenticated
    case unauthorized
    case invalidResponse
    case fetchFailed
    case messageNotFound

    var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            return "Please sign in to Google to access your emails"
        case .unauthorized:
            return "Your session has expired. Please sign in again."
        case .invalidResponse:
            return "Invalid response from Gmail"
        case .fetchFailed:
            return "Failed to fetch emails"
        case .messageNotFound:
            return "Email not found"
        }
    }
}
