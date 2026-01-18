import SwiftUI

// MARK: - Simple Web Link View

/// Clean, simple URL input view matching reference design.
/// Shows "Paste any URL to listen" with single text field and Continue button.
struct SimpleWebLinkView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var coordinator = ImportCoordinator.shared

    @State private var urlText: String = ""
    @State private var isImporting = false
    @State private var importError: String?
    @State private var importedArticle: Article?
    @State private var showReader = false

    private var isValidURL: Bool {
        coordinator.validateURL(urlText).isValid
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Title
            Text("Paste any URL to listen")
                .font(.title2.weight(.semibold))
                .padding(.bottom, 24)

            // URL input field
            TextField("https://www.any-website.com/...", text: $urlText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .padding()
                .background(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Color.yellow, lineWidth: 2)
                )
                .padding(.horizontal)

            Spacer()

            // Continue button
            Button {
                Task {
                    await importURL()
                }
            } label: {
                HStack {
                    if isImporting {
                        ProgressView()
                            .tint(.white)
                            .padding(.trailing, 8)
                        Text(coordinator.progress.stage.displayName)
                    } else {
                        Text("Continue")
                            .fontWeight(.medium)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(isValidURL ? Color.gray.opacity(0.4) : Color.gray.opacity(0.3))
                .foregroundStyle(isValidURL ? .primary : .secondary)
                .cornerRadius(16)
            }
            .disabled(!isValidURL || isImporting)
            .padding(.horizontal)
            .padding(.bottom, 16)
        }
        .navigationTitle("Web Link")
        .navigationBarTitleDisplayMode(.inline)
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
    }

    private func importURL() async {
        isImporting = true
        importError = nil

        do {
            let article = try await coordinator.importFromURL(urlText)
            importedArticle = article
            isImporting = false
            showReader = true
        } catch {
            isImporting = false
            importError = error.localizedDescription
        }
    }
}

#Preview {
    NavigationStack {
        SimpleWebLinkView()
    }
}
