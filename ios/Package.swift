// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "ListenAI",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "ListenAI",
            targets: ["ListenAI"]
        ),
    ],
    dependencies: [
        // Future: Add neural TTS package when stable SPM support is available
        // Options being evaluated:
        // - Sherpa-ONNX (requires building from source, no SPM yet)
        // - Piper TTS (fragmented packages, quality issues on some devices)
    ],
    targets: [
        .target(
            name: "ListenAI",
            dependencies: [],
            path: "Sources"
        ),
        .testTarget(
            name: "ListenAITests",
            dependencies: ["ListenAI"],
            path: "Tests"
        ),
    ]
)
