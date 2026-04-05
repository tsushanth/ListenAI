import Foundation

/// Product identifiers for ReadAloud AI in-app purchases
enum ProductID: String, CaseIterable {
    // Subscriptions
    case weekly = "com.kreativekoala.listenai.weekly"
    case annual = "com.kreativekoala.listenai.annual"
    // One-time
    case lifetime = "com.kreativekoala.listenai.lifetime"

    static var subscriptionIDs: [String] {
        [weekly.rawValue, annual.rawValue]
    }

    static var allIDs: [String] {
        allCases.map(\.rawValue)
    }
}
