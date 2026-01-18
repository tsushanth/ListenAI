import SwiftUI
import UniformTypeIdentifiers

// MARK: - Document Picker Sheet

/// Bottom sheet for document import with device/cloud options.
/// Matches reference design with "Upload from Device" and "Google Drive" options.
struct DocumentPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var coordinator = ImportCoordinator.shared

    @State private var showFilePicker = false
    @State private var isImporting = false
    @State private var importError: String?
    @State private var importedArticle: Article?
    @State private var showReader = false

    var body: some View {
        VStack(spacing: 16) {
            // Drag indicator
            Capsule()
                .fill(Color.secondary.opacity(0.3))
                .frame(width: 36, height: 5)
                .padding(.top, 8)

            // Title
            Text("Document")
                .font(.title3.weight(.semibold))
                .padding(.top, 8)

            // Options
            VStack(spacing: 12) {
                // Upload from Device
                DocumentOptionRow(
                    icon: "square.and.arrow.up",
                    iconColor: .yellow,
                    title: "Upload from Device",
                    subtitle: "PDF, ePub, DOCX, TXT & more"
                ) {
                    showFilePicker = true
                }

                // Google Drive - Hidden until integration is complete
                // TODO: Implement Google Drive picker and unhide this option
                // DocumentOptionRow(
                //     icon: "externaldrive.fill.badge.icloud",
                //     iconColor: .green,
                //     iconBackgroundColor: .white,
                //     title: "Google Drive",
                //     subtitle: "Upload files from Google Drive",
                //     showGoogleDriveIcon: true
                // ) {
                //     // Google Drive picker action
                // }
            }
            .padding(.horizontal)

            Spacer()
        }
        .fileImporter(
            isPresented: $showFilePicker,
            allowedContentTypes: [.pdf, .plainText, .rtf, .epub],
            allowsMultipleSelection: false
        ) { result in
            handleFileImport(result)
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
        .overlay {
            if isImporting {
                ZStack {
                    Color.black.opacity(0.3)
                        .ignoresSafeArea()

                    VStack(spacing: 16) {
                        ProgressView()
                            .scaleEffect(1.5)

                        Text(coordinator.progress.message)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(24)
                    .background(Color(.systemBackground))
                    .cornerRadius(16)
                }
            }
        }
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }

            isImporting = true

            Task {
                do {
                    // Access security-scoped resource
                    let canAccess = url.startAccessingSecurityScopedResource()
                    defer {
                        if canAccess {
                            url.stopAccessingSecurityScopedResource()
                        }
                    }

                    let article: Article
                    if url.pathExtension.lowercased() == "pdf" {
                        article = try await coordinator.importFromPDF(url)
                    } else {
                        // Text file
                        let data = try Data(contentsOf: url)
                        if let text = String(data: data, encoding: .utf8) {
                            article = try await coordinator.importFromText(text, title: url.deletingPathExtension().lastPathComponent)
                        } else {
                            throw ExtractionError.unsupportedFormat(format: url.pathExtension)
                        }
                    }

                    await MainActor.run {
                        importedArticle = article
                        isImporting = false
                        showReader = true
                    }
                } catch {
                    await MainActor.run {
                        isImporting = false
                        importError = error.localizedDescription
                    }
                }
            }

        case .failure(let error):
            importError = error.localizedDescription
        }
    }
}

// MARK: - Document Option Row

struct DocumentOptionRow: View {
    let icon: String
    var iconColor: Color = .primary
    var iconBackgroundColor: Color? = nil
    let title: String
    let subtitle: String
    var showGoogleDriveIcon: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                // Icon
                ZStack {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(iconBackgroundColor ?? iconColor.opacity(0.15))
                        .frame(width: 48, height: 48)

                    if showGoogleDriveIcon {
                        // Google Drive icon placeholder
                        Image(systemName: "triangle.fill")
                            .font(.title2)
                            .foregroundStyle(
                                LinearGradient(
                                    colors: [.green, .blue, .yellow, .red],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                    } else {
                        Image(systemName: icon)
                            .font(.title3)
                            .foregroundStyle(iconColor)
                    }
                }

                // Text
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body)
                        .fontWeight(.medium)
                        .foregroundStyle(.primary)

                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding()
            .background(Color(.secondarySystemGroupedBackground))
            .cornerRadius(16)
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    DocumentPickerSheet()
}
