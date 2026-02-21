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
        // RevenueCat for subscription management and attribution
        .package(url: "https://github.com/RevenueCat/purchases-ios.git", from: "5.0.0"),

        // Facebook SDK for Meta Ads attribution and CAPI
        .package(url: "https://github.com/facebook/facebook-ios-sdk.git", from: "17.0.0"),

        // Future: Add neural TTS package when stable SPM support is available
        // Options being evaluated:
        // - Sherpa-ONNX (requires building from source, no SPM yet)
        // - Piper TTS (fragmented packages, quality issues on some devices)
    ],
    targets: [
        .target(
            name: "ListenAI",
            dependencies: [
                .product(name: "RevenueCat", package: "purchases-ios"),
                .product(name: "FacebookCore", package: "facebook-ios-sdk"),
            ],
            path: "Sources"
        ),
        .testTarget(
            name: "ListenAITests",
            dependencies: ["ListenAI"],
            path: "Tests"
        ),
    ]
)
