import SwiftUI
import MessageUI

// MARK: - Mail Import View

/// Email inbox view for importing emails to listen to.
/// Shows inbox with search and filter, matching reference design.
struct MailImportView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var coordinator = ImportCoordinator.shared
    @StateObject private var googleAuth = GoogleAuthService.shared
    @StateObject private var gmailService = GmailService.shared

    @State private var searchText: String = ""
    @State private var selectedEmail: GmailMessage?
    @State private var importError: String?
    @State private var importedArticle: Article?
    @State private var showReader = false
    @State private var isConnecting = false
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            // Search bar
            HStack(spacing: 12) {
                Image(systemName: "line.3.horizontal")
                    .font(.title3)
                    .foregroundStyle(.secondary)

                TextField("Search in mail", text: $searchText)
                    .textInputAutocapitalization(.never)
                    .onSubmit {
                        searchEmails()
                    }

                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                        refreshEmails()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }

                Button {
                    refreshEmails()
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.title3)
                        .foregroundStyle(.yellow)
                }
            }
            .padding()
            .background(Color(.secondarySystemGroupedBackground))
            .cornerRadius(12)
            .padding(.horizontal)
            .padding(.top, 8)

            // Content
            if !googleAuth.isAuthenticated {
                // Not connected - show connect prompt
                notConnectedView
            } else if gmailService.isLoading && gmailService.emails.isEmpty {
                // Loading initial emails
                loadingView
            } else if gmailService.emails.isEmpty {
                // No emails found
                emptyView
            } else {
                // Email list
                emailListView
            }
        }
        .navigationTitle("Gmail")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                if googleAuth.isAuthenticated {
                    Button {
                        showSettings = true
                    } label: {
                        if let avatarURL = googleAuth.userAvatarURL {
                            AsyncImage(url: avatarURL) { image in
                                image.resizable()
                                    .scaledToFill()
                            } placeholder: {
                                Image(systemName: "person.circle.fill")
                            }
                            .frame(width: 28, height: 28)
                            .clipShape(Circle())
                        } else {
                            Image(systemName: "person.circle.fill")
                                .font(.title3)
                        }
                    }
                }
            }

            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.body)
                }
            }
        }
        .onAppear {
            if googleAuth.isAuthenticated && gmailService.emails.isEmpty {
                loadEmails()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            // Proactively refresh token when app comes to foreground
            Task {
                await googleAuth.refreshTokenIfNeeded()
            }
        }
        .alert("Error", isPresented: .constant(importError != nil)) {
            Button("OK") { importError = nil }
        } message: {
            Text(importError ?? "")
        }
        .fullScreenCover(isPresented: $showReader) {
            if let article = importedArticle {
                NavigationStack {
                    ArticleReaderView(article: article)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button("Done") {
                                    showReader = false
                                    dismiss()
                                }
                            }
                        }
                }
                .environmentObject(AudioPlaybackService.shared)
                .environmentObject(QueueManager.shared)
            }
        }
        .onChange(of: showReader) { _, isShowing in
            // Ensure mini player is shown when ArticleReaderView fullscreen cover is dismissed
            if !isShowing {
                AudioPlaybackService.shared.isArticleReaderActive = false
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                gmailSettingsView
            }
        }
    }

    // MARK: - Subviews

    private var notConnectedView: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "envelope.badge")
                .font(.system(size: 64))
                .foregroundStyle(.secondary)

            Text("Connect Gmail")
                .font(.title2.bold())

            Text("Sign in with Google to import and listen to your emails")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            if isConnecting {
                ProgressView()
                    .padding()
            } else {
                Button {
                    connectGmail()
                } label: {
                    HStack {
                        Image(systemName: "g.circle.fill")
                            .foregroundStyle(.white)
                        Text("Sign in with Google")
                            .fontWeight(.semibold)
                    }
                    .padding(.horizontal, 24)
                    .padding(.vertical, 14)
                    .background(Color.blue)
                    .foregroundStyle(.white)
                    .cornerRadius(10)
                }
            }

            Spacer()

            Text("We only request read access to your emails. Your data stays private.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
                .padding(.bottom, 20)
        }
    }

    private var loadingView: some View {
        VStack(spacing: 16) {
            Spacer()
            ProgressView()
            Text("Loading emails...")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
        }
    }

    private var emptyView: some View {
        VStack(spacing: 16) {
            Spacer()

            Image(systemName: "tray")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)

            Text("No emails found")
                .font(.headline)

            if !searchText.isEmpty {
                Text("Try a different search term")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Button("Clear Search") {
                    searchText = ""
                    refreshEmails()
                }
                .buttonStyle(.bordered)
            } else {
                Text("Your inbox appears to be empty")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Button("Refresh") {
                    refreshEmails()
                }
                .buttonStyle(.bordered)
            }

            Spacer()
        }
    }

    private var emailListView: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(gmailService.emails) { email in
                    GmailEmailRow(email: email) {
                        selectEmail(email)
                    }
                    Divider()
                        .padding(.leading, 72)
                }

                // Load more button
                if gmailService.hasMorePages {
                    Button {
                        loadMoreEmails()
                    } label: {
                        if gmailService.isLoading {
                            ProgressView()
                                .padding()
                        } else {
                            Text("Load More")
                                .font(.subheadline)
                                .foregroundStyle(.blue)
                                .padding()
                        }
                    }
                    .disabled(gmailService.isLoading)
                }
            }
        }
        .refreshable {
            await refreshEmailsAsync()
        }
    }

    private var gmailSettingsView: some View {
        List {
            Section {
                HStack {
                    if let avatarURL = googleAuth.userAvatarURL {
                        AsyncImage(url: avatarURL) { image in
                            image.resizable()
                                .scaledToFill()
                        } placeholder: {
                            Image(systemName: "person.circle.fill")
                                .font(.largeTitle)
                        }
                        .frame(width: 50, height: 50)
                        .clipShape(Circle())
                    } else {
                        Image(systemName: "person.circle.fill")
                            .font(.largeTitle)
                            .frame(width: 50, height: 50)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text(googleAuth.userName ?? "Google User")
                            .font(.headline)
                        Text(googleAuth.userEmail ?? "")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 8)
            }

            Section {
                Button(role: .destructive) {
                    disconnectGmail()
                } label: {
                    HStack {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                        Text("Sign Out")
                    }
                }
            }
        }
        .navigationTitle("Gmail Account")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") {
                    showSettings = false
                }
            }
        }
    }

    // MARK: - Actions

    private func connectGmail() {
        isConnecting = true
        Task {
            do {
                try await googleAuth.signIn()
                isConnecting = false
                loadEmails()
            } catch let error as GoogleAuthError {
                isConnecting = false
                if case .userCancelled = error {
                    // Don't show error for user cancellation
                } else {
                    importError = error.localizedDescription
                }
            } catch {
                isConnecting = false
                importError = error.localizedDescription
            }
        }
    }

    private func disconnectGmail() {
        googleAuth.signOut()
        gmailService.clearCache()
        showSettings = false
    }

    private func loadEmails() {
        Task {
            do {
                try await gmailService.fetchEmails(refresh: true)
            } catch {
                handleGmailError(error)
            }
        }
    }

    private func refreshEmails() {
        Task {
            await refreshEmailsAsync()
        }
    }

    private func refreshEmailsAsync() async {
        do {
            try await gmailService.fetchEmails(refresh: true)
        } catch {
            await MainActor.run {
                handleGmailError(error)
            }
        }
    }

    private func searchEmails() {
        Task {
            do {
                try await gmailService.searchEmails(query: searchText)
            } catch {
                handleGmailError(error)
            }
        }
    }

    private func loadMoreEmails() {
        Task {
            do {
                try await gmailService.loadMore()
            } catch {
                handleGmailError(error)
            }
        }
    }

    /// Handle Gmail errors - for auth errors, sign out silently so user sees sign-in button
    /// For other errors, show an alert
    private func handleGmailError(_ error: Error) {
        // Check if it's an auth-related error
        if let gmailError = error as? GmailError {
            switch gmailError {
            case .notAuthenticated, .unauthorized:
                // Sign out silently - the UI will show the sign-in button
                googleAuth.signOut()
                gmailService.clearCache()
                return
            default:
                break
            }
        }

        if let authError = error as? GoogleAuthError {
            switch authError {
            case .notAuthenticated, .noAccessToken, .noRefreshToken, .refreshFailed:
                // Sign out silently - the UI will show the sign-in button
                googleAuth.signOut()
                gmailService.clearCache()
                return
            default:
                break
            }
        }

        // For non-auth errors, show the alert
        importError = error.localizedDescription
    }

    private func selectEmail(_ email: GmailMessage) {
        Task {
            do {
                // Fetch full email content if needed
                let fullEmail: GmailMessage
                if email.body.isEmpty {
                    fullEmail = try await gmailService.fetchFullEmail(messageId: email.id)
                } else {
                    fullEmail = email
                }

                // Use only the email body - the title will be shown separately
                // Email-specific cleaning options will strip HTML, signatures, headers, etc.
                let article = try await coordinator.importFromText(
                    fullEmail.body,
                    title: fullEmail.subject,
                    options: .email,
                    saveToLibrary: false  // Don't auto-save - user must explicitly add to library
                )
                await MainActor.run {
                    importedArticle = article
                    showReader = true
                }
            } catch {
                await MainActor.run {
                    importError = error.localizedDescription
                }
            }
        }
    }
}

// MARK: - Gmail Email Row

struct GmailEmailRow: View {
    let email: GmailMessage
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 12) {
                // Avatar
                Circle()
                    .fill(avatarColor)
                    .frame(width: 44, height: 44)
                    .overlay {
                        Text(String(email.senderName.prefix(1)).uppercased())
                            .font(.headline)
                            .foregroundStyle(.white)
                    }

                // Content
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(email.senderName)
                            .font(.subheadline)
                            .fontWeight(email.isRead ? .regular : .semibold)
                            .foregroundStyle(.primary)
                            .lineLimit(1)

                        Spacer()

                        if email.hasAttachment {
                            Image(systemName: "paperclip")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        Text(email.date.formatted(.relative(presentation: .named)))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Text(email.subject.isEmpty ? "(No Subject)" : email.subject)
                        .font(.subheadline)
                        .fontWeight(email.isRead ? .regular : .medium)
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Text(email.snippet)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
            .background(email.isRead ? Color.clear : Color.blue.opacity(0.05))
        }
        .buttonStyle(.plain)
    }

    private var avatarColor: Color {
        // Generate a consistent color based on sender name
        let colors: [Color] = [.blue, .green, .orange, .purple, .pink, .teal, .indigo]
        let hash = abs(email.senderName.hashValue)
        return colors[hash % colors.count]
    }
}

// MARK: - Legacy Email Item Model (for backwards compatibility)

struct EmailItem: Identifiable {
    let id = UUID()
    let sender: String
    let senderEmail: String
    let subject: String
    let preview: String
    let body: String
    let date: Date
    let isRead: Bool
    let hasAttachment: Bool
}

#Preview {
    NavigationStack {
        MailImportView()
    }
}
