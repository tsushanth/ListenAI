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
        // Facebook SDK for Meta Ads attribution and CAPI
        .package(url: "https://github.com/facebook/facebook-ios-sdk.git", from: "18.0.0"),
    ],
    targets: [
        .target(
            name: "ListenAI",
            dependencies: [
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
