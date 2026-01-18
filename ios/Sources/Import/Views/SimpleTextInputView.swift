import SwiftUI

// MARK: - Simple Text Input View

/// Clean, simple text input view matching reference design.
/// Shows just a text field and "Save & Listen" button.
struct SimpleTextInputView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var coordinator = ImportCoordinator.shared

    @State private var text: String = ""
    @State private var isImporting = false
    @State private var importError: String?
    @State private var importedArticle: Article?
    @State private var showReader = false

    var body: some View {
        VStack(spacing: 0) {
            // Text input area
            TextEditor(text: $text)
                .font(.body)
                .padding(.horizontal)
                .padding(.top, 16)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("Type or paste your text here...")
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 20)
                            .padding(.top, 24)
                            .allowsHitTesting(false)
                    }
                }

            Spacer()

            // Save & Listen button
            Button {
                Task {
                    await saveAndListen()
                }
            } label: {
                HStack {
                    if isImporting {
                        ProgressView()
                            .tint(.white)
                            .padding(.trailing, 8)
                    }
                    Text("Save & Listen")
                        .fontWeight(.medium)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Color.gray.opacity(0.3) : Color.gray.opacity(0.4))
                .foregroundStyle(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .secondary : .primary)
                .cornerRadius(16)
            }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isImporting)
            .padding(.horizontal)
            .padding(.bottom, 16)
        }
        .navigationTitle("Type or Paste Text")
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

    private func saveAndListen() async {
        isImporting = true
        importError = nil

        do {
            let article = try await coordinator.importFromText(text)
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
        SimpleTextInputView()
    }
}
