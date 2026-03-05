import Foundation
import RevenueCat
import AdServices
import FirebaseAnalytics

// MARK: - RevenueCat Manager

/// Manages subscriptions via RevenueCat with Apple Search Ads attribution
@MainActor
final class RevenueCatManager: ObservableObject {

    // MARK: - Singleton

    static let shared = RevenueCatManager()

    // MARK: - Published Properties

    /// Current customer info from RevenueCat
    @Published private(set) var customerInfo: CustomerInfo?

    /// Whether user has active premium subscription
    @Published private(set) var isPremium: Bool = false

    /// Available packages from the current offering
    @Published private(set) var packages: [Package] = []

    /// Loading state
    @Published private(set) var isLoading: Bool = false

    /// Error message for UI
    @Published var errorMessage: String?
    @Published var showError: Bool = false

    // MARK: - Constants

    /// RevenueCat API key - get this from RevenueCat dashboard
    /// Dashboard: https://app.revenuecat.com
    private static let apiKey = "appl_RiOykCWJEObuXjIUMNkbAxNoFWT"

    /// Entitlement identifier for premium access
    private static let premiumEntitlementID = "premium"

    // MARK: - Initialization

    private init() {}

    // MARK: - Configuration

    /// Configure RevenueCat SDK - call this at app launch
    func configure() async {
        // Configure RevenueCat
        #if DEBUG
        Purchases.logLevel = .debug
        #else
        Purchases.logLevel = .warn
        #endif
        Purchases.configure(withAPIKey: Self.apiKey)

        // Set customer attributes for segmentation
        Purchases.shared.attribution.setAttributes([
            "$appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "app_name": "ReadAloudAI",
            "platform": "ios"
        ])

        // Enable Apple Search Ads attribution
        await collectAppleSearchAdsAttribution()

        // Listen for customer info updates
        Purchases.shared.delegate = RevenueCatPurchasesDelegate.shared

        // Fetch initial customer info and offerings
        await refreshCustomerInfo()
        await loadOfferings()

        print("[RevenueCat] Configured successfully")
    }

    // MARK: - Apple Search Ads Attribution

    /// Collect and send Apple Search Ads attribution to RevenueCat
    private func collectAppleSearchAdsAttribution() async {
        // Apple Search Ads attribution (iOS 14.3+)
        if #available(iOS 14.3, *) {
            do {
                let token = try AAAttribution.attributionToken()
                print("[RevenueCat] Got Apple Search Ads attribution token")

                // RevenueCat automatically collects this, but we can also set it explicitly
                Purchases.shared.attribution.enableAdServicesAttributionTokenCollection()

            } catch {
                print("[RevenueCat] Apple Search Ads attribution not available: \(error.localizedDescription)")
                // This is normal for organic installs or simulator
            }
        }
    }

    // MARK: - Customer Info

    /// Refresh customer info from RevenueCat
    func refreshCustomerInfo() async {
        do {
            let info = try await Purchases.shared.customerInfo()
            self.customerInfo = info
            self.isPremium = info.entitlements[Self.premiumEntitlementID]?.isActive == true

            // Update usage tracker
            UsageTrackerService.shared.setTier(isPremium ? .pro : .free)

            print("[RevenueCat] Customer info refreshed. Premium: \(isPremium)")
        } catch {
            print("[RevenueCat] Failed to get customer info: \(error)")
        }
    }

    // MARK: - Offerings

    /// Load available offerings/packages
    func loadOfferings() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let offerings = try await Purchases.shared.offerings()

            if let current = offerings.current {
                self.packages = current.availablePackages
                print("[RevenueCat] Loaded \(packages.count) packages from '\(current.identifier)' offering")

                for package in packages {
                    print("[RevenueCat] - \(package.identifier): \(package.localizedPriceString)")
                }
            } else {
                print("[RevenueCat] No current offering available")
            }
        } catch {
            print("[RevenueCat] Failed to load offerings: \(error)")
            errorMessage = "Failed to load subscription options"
            showError = true
        }
    }

    // MARK: - Purchases

    /// Purchase a package
    func purchase(_ package: Package) async throws {
        isLoading = true
        defer { isLoading = false }

        do {
            let result = try await Purchases.shared.purchase(package: package)

            // Check if user cancelled
            if result.userCancelled {
                print("[RevenueCat] User cancelled purchase")
                throw PurchaseError.userCancelled
            }

            // Update state
            self.customerInfo = result.customerInfo
            self.isPremium = result.customerInfo.entitlements[Self.premiumEntitlementID]?.isActive == true

            // Update usage tracker
            UsageTrackerService.shared.setTier(isPremium ? .pro : .free)

            print("[RevenueCat] Purchase successful: \(package.identifier)")

            // Track purchase events for attribution
            let productId = package.storeProduct.productIdentifier
            let price = package.storeProduct.price
            let currency = package.storeProduct.currencyCode ?? "USD"
            let params: [String: Any] = ["product_id": productId, "price": Double(truncating: price as NSNumber), "currency": currency]
            Analytics.logEvent(AnalyticsEventPurchase, parameters: [
                AnalyticsParameterCurrency: currency,
                AnalyticsParameterValue: Double(truncating: price as NSNumber),
                AnalyticsParameterItems: [[AnalyticsParameterItemID: productId]]
            ])
            Analytics.logEvent("purchase_success", parameters: params)
            TikTokHelper.shared.trackEvent("purchase_success", properties: params)

        } catch let error as PurchaseError {
            throw error
        } catch {
            print("[RevenueCat] Purchase failed: \(error)")
            errorMessage = error.localizedDescription
            showError = true
            throw PurchaseError.purchaseFailed(error.localizedDescription)
        }
    }

    /// Restore previous purchases
    func restorePurchases() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let info = try await Purchases.shared.restorePurchases()
            self.customerInfo = info
            self.isPremium = info.entitlements[Self.premiumEntitlementID]?.isActive == true

            // Update usage tracker
            UsageTrackerService.shared.setTier(isPremium ? .pro : .free)

            if isPremium {
                print("[RevenueCat] Restored premium subscription")
            } else {
                print("[RevenueCat] No active subscription found")
                errorMessage = "No active subscription found"
                showError = true
            }
        } catch {
            print("[RevenueCat] Restore failed: \(error)")
            errorMessage = "Failed to restore: \(error.localizedDescription)"
            showError = true
        }
    }

    // MARK: - Helper Methods

    /// Get the weekly package
    var weeklyPackage: Package? {
        packages.first { $0.packageType == .weekly }
    }

    /// Get the monthly package
    var monthlyPackage: Package? {
        packages.first { $0.packageType == .monthly }
    }

    /// Get the 3-month package
    var threeMonthPackage: Package? {
        packages.first { $0.packageType == .threeMonth }
    }

    /// Get the 6-month package
    var sixMonthPackage: Package? {
        packages.first { $0.packageType == .sixMonth }
    }

    /// Get the annual package
    var annualPackage: Package? {
        packages.first { $0.packageType == .annual }
    }

    /// Get the lifetime package
    var lifetimePackage: Package? {
        packages.first { $0.packageType == .lifetime }
    }

    /// Set user ID for attribution (call after user signs in)
    func setUserID(_ userID: String) async {
        do {
            let (info, _) = try await Purchases.shared.logIn(userID)
            self.customerInfo = info
            self.isPremium = info.entitlements[Self.premiumEntitlementID]?.isActive == true
            print("[RevenueCat] User ID set: \(userID)")
        } catch {
            print("[RevenueCat] Failed to set user ID: \(error)")
        }
    }

    /// Clear user ID on logout
    func clearUserID() async {
        do {
            let info = try await Purchases.shared.logOut()
            self.customerInfo = info
            self.isPremium = info.entitlements[Self.premiumEntitlementID]?.isActive == true
            print("[RevenueCat] User logged out")
        } catch {
            print("[RevenueCat] Failed to log out: \(error)")
        }
    }

    /// Update state from delegate callback (internal use)
    func updateFromDelegate(customerInfo: CustomerInfo) {
        self.customerInfo = customerInfo
        let isPremium = customerInfo.entitlements[Self.premiumEntitlementID]?.isActive == true
        self.isPremium = isPremium
        UsageTrackerService.shared.setTier(isPremium ? .pro : .free)
        print("[RevenueCat] Customer info updated via delegate. Premium: \(isPremium)")
    }
}

// MARK: - Purchase Error

enum PurchaseError: LocalizedError {
    case userCancelled
    case purchaseFailed(String)
    case productNotFound

    var errorDescription: String? {
        switch self {
        case .userCancelled:
            return "Purchase was cancelled"
        case .purchaseFailed(let message):
            return "Purchase failed: \(message)"
        case .productNotFound:
            return "Product not found"
        }
    }
}

// MARK: - Purchases Delegate

/// Delegate to handle real-time customer info updates
private class RevenueCatPurchasesDelegate: NSObject, RevenueCat.PurchasesDelegate {
    static let shared = RevenueCatPurchasesDelegate()

    func purchases(_ purchases: Purchases, receivedUpdated customerInfo: CustomerInfo) {
        Task { @MainActor in
            RevenueCatManager.shared.updateFromDelegate(customerInfo: customerInfo)
        }
    }
}

// MARK: - Package Extensions

extension Package {
    /// Human-readable description of the package
    var displayDescription: String {
        switch packageType {
        case .weekly:
            return "Billed weekly"
        case .monthly:
            return "Billed monthly"
        case .threeMonth:
            return "Save 33% - Billed quarterly"
        case .sixMonth:
            return "Save 44% - Billed every 6 months"
        case .annual:
            return "Best value - Save 90%"
        case .lifetime:
            return "One-time purchase - Forever"
        default:
            return storeProduct.localizedDescription
        }
    }

    /// Whether this package has a free trial
    var hasFreeTrial: Bool {
        storeProduct.introductoryDiscount?.paymentMode == .freeTrial
    }

    /// Free trial duration string
    var freeTrialDuration: String? {
        guard let intro = storeProduct.introductoryDiscount,
              intro.paymentMode == .freeTrial else { return nil }

        let unit = intro.subscriptionPeriod.unit
        let value = intro.subscriptionPeriod.value

        switch unit {
        case .day: return "\(value) day\(value > 1 ? "s" : "")"
        case .week: return "\(value) week\(value > 1 ? "s" : "")"
        case .month: return "\(value) month\(value > 1 ? "s" : "")"
        case .year: return "\(value) year\(value > 1 ? "s" : "")"
        @unknown default: return nil
        }
    }
}
