import Foundation

/// Product identifiers for ReadAloud AI in-app purchases.
///
/// Paywall surfaces only 3 plans (weekly / monthly / annual) — rendering
/// 5+ plans side-by-side squished the cards on iPhone widths and the value
/// prop became unreadable. Quarterly + semiannual still exist in StoreKit
/// for ASC promo offers but are no longer presented in the paywall picker.
enum ProductID: String, CaseIterable {
    case weekly = "com.kreativekoala.listenai.weekly"
    case monthly = "com.kreativekoala.listenai.monthly"
    case annual = "com.kreativekoala.listenai.annual"

    static var subscriptionIDs: [String] {
        allCases.map(\.rawValue)
    }

    static var allIDs: [String] {
        allCases.map(\.rawValue)
    }
}
