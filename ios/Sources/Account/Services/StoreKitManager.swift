import Foundation
import StoreKit

// MARK: - Subscription Plan

/// Available subscription plans
enum SubscriptionPlan: String, CaseIterable, Identifiable {
    case weekly = "com.kreativekoala.listenai.weekly"
    case monthly = "com.kreativekoala.listenai.monthly"
    case quarterly = "com.kreativekoala.listenai.quarterly"
    case semiannual = "com.kreativekoala.listenai.semiannual"
    case annual = "com.kreativekoala.listenai.annual"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .weekly: return "Weekly"
        case .monthly: return "Monthly"
        case .quarterly: return "3 Months"
        case .semiannual: return "6 Months"
        case .annual: return "Annual"
        }
    }

    var description: String {
        switch self {
        case .weekly: return "Billed weekly"
        case .monthly: return "Billed monthly"
        case .quarterly: return "Billed every 3 months"
        case .semiannual: return "Billed every 6 months"
        case .annual: return "Best value - Save 90%"
        }
    }

    /// Character limit per month for this plan
    var monthlyCharacterLimit: Int {
        // Premium users get unlimited (very high limit)
        return 10_000_000 // 10M characters
    }
}

// MARK: - Store Error

enum StoreError: LocalizedError {
    case productNotFound
    case purchaseFailed(String)
    case verificationFailed
    case userCancelled
    case pending
    case unknown

    var errorDescription: String? {
        switch self {
        case .productNotFound:
            return "Subscription product not found"
        case .purchaseFailed(let message):
            return "Purchase failed: \(message)"
        case .verificationFailed:
            return "Could not verify purchase"
        case .userCancelled:
            return "Purchase was cancelled"
        case .pending:
            return "Purchase is pending approval"
        case .unknown:
            return "An unknown error occurred"
        }
    }
}

// MARK: - StoreKit Manager

/// Manages StoreKit2 subscriptions for ReadAloud AI
@MainActor
final class StoreKitManager: ObservableObject {

    // MARK: - Published Properties

    /// Available products from App Store
    @Published private(set) var products: [Product] = []

    /// Current active subscription (if any)
    @Published private(set) var currentSubscription: Product?

    /// Whether user has an active premium subscription
    @Published private(set) var isPremium: Bool = false

    /// Loading state
    @Published private(set) var isLoading: Bool = false

    /// Error message
    @Published var errorMessage: String?

    /// Show error alert
    @Published var showError: Bool = false

    // MARK: - Private Properties

    private var updateListenerTask: Task<Void, Error>?
    private let productIDs = Set(SubscriptionPlan.allCases.map { $0.rawValue })

    // MARK: - Singleton

    static let shared = StoreKitManager()

    // MARK: - Initialization

    private init() {
        print("[StoreKit] StoreKitManager.init() called - stack trace would help here")
        // Start listening for transaction updates
        updateListenerTask = listenForTransactions()

        // Load products and check subscription status
        Task {
            print("[StoreKit] Starting product load task...")
            await loadProducts()
            await updateSubscriptionStatus()
        }
    }

    deinit {
        updateListenerTask?.cancel()
    }

    // MARK: - Public Methods

    /// Load available products from the App Store
    func loadProducts() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let storeProducts = try await Product.products(for: productIDs)

            // Sort: annual first (better value), then weekly
            products = storeProducts.sorted { product1, product2 in
                // Annual should come first
                if product1.id.contains("annual") { return true }
                if product2.id.contains("annual") { return false }
                return product1.price < product2.price
            }

            print("[StoreKit] Loaded \(products.count) products")
            for product in products {
                print("[StoreKit] - \(product.id): \(product.displayPrice)")
            }
        } catch {
            print("[StoreKit] Failed to load products: \(error)")
            errorMessage = "Failed to load subscription options"
            showError = true
        }
    }

    /// Purchase a subscription
    func purchase(_ product: Product) async throws {
        isLoading = true
        defer { isLoading = false }

        do {
            let result = try await product.purchase()

            switch result {
            case .success(let verification):
                // Verify the transaction
                let transaction = try checkVerified(verification)

                // Update subscription status
                await updateSubscriptionStatus()

                // Finish the transaction
                await transaction.finish()

                print("[StoreKit] Purchase successful: \(product.id)")

            case .userCancelled:
                print("[StoreKit] User cancelled purchase")
                throw StoreError.userCancelled

            case .pending:
                print("[StoreKit] Purchase pending")
                throw StoreError.pending

            @unknown default:
                throw StoreError.unknown
            }
        } catch StoreError.userCancelled {
            // Don't show error for user cancellation
            throw StoreError.userCancelled
        } catch StoreError.pending {
            errorMessage = "Your purchase is pending approval"
            showError = true
            throw StoreError.pending
        } catch {
            print("[StoreKit] Purchase failed: \(error)")
            errorMessage = error.localizedDescription
            showError = true
            throw StoreError.purchaseFailed(error.localizedDescription)
        }
    }

    /// Restore previous purchases
    func restorePurchases() async {
        isLoading = true
        defer { isLoading = false }

        do {
            // Sync with App Store
            try await AppStore.sync()

            // Update subscription status
            await updateSubscriptionStatus()

            if isPremium {
                print("[StoreKit] Restored premium subscription")
            } else {
                print("[StoreKit] No active subscription found")
                errorMessage = "No active subscription found"
                showError = true
            }
        } catch {
            print("[StoreKit] Restore failed: \(error)")
            errorMessage = "Failed to restore purchases: \(error.localizedDescription)"
            showError = true
        }
    }

    /// Check current subscription status
    func updateSubscriptionStatus() async {
        var foundSubscription: Product? = nil
        var foundTransaction: Transaction? = nil

        // Check all subscription transactions
        for await result in Transaction.currentEntitlements {
            do {
                let transaction = try checkVerified(result)

                // Check if this is one of our subscription products
                if productIDs.contains(transaction.productID) {
                    // Find the matching product
                    if let product = products.first(where: { $0.id == transaction.productID }) {
                        foundSubscription = product
                        foundTransaction = transaction
                        break
                    }
                }
            } catch {
                print("[StoreKit] Failed to verify transaction: \(error)")
            }
        }

        currentSubscription = foundSubscription
        isPremium = foundSubscription != nil

        // Update usage tracker with new tier
        updateUsageTier()

        // Sync with backend if we have a valid subscription
        if let transaction = foundTransaction {
            await syncWithBackend(transaction: transaction)
        }

        print("[StoreKit] Subscription status: \(isPremium ? "Premium (\(currentSubscription?.id ?? "unknown"))" : "Free")")
    }

    /// Sync subscription status with backend
    private func syncWithBackend(transaction: Transaction) async {
        guard let cloudService = TTSServiceFactory.listenAICloudService else {
            print("[StoreKit] Backend not configured, skipping sync")
            return
        }

        do {
            let response = try await cloudService.syncSubscription(
                productId: transaction.productID,
                transactionId: String(transaction.id),
                originalTransactionId: String(transaction.originalID),
                purchaseDate: transaction.purchaseDate,
                expiresDate: transaction.expirationDate,
                isTrialPeriod: transaction.offerType == .introductory,
                cancellationDate: transaction.revocationDate
            )

            print("[StoreKit] Backend sync successful: tier=\(response.subscription.tier), status=\(response.subscription.status)")

            // Refresh user account subscription status
            await UserAccountViewModel.shared.refreshSubscriptionStatus()
        } catch {
            print("[StoreKit] Backend sync failed: \(error)")
            // Don't fail silently - purchases still work locally, sync will retry on next app launch
        }
    }

    /// Get the product for a specific plan
    func product(for plan: SubscriptionPlan) -> Product? {
        products.first { $0.id == plan.rawValue }
    }

    /// Get formatted price for a plan
    func formattedPrice(for plan: SubscriptionPlan) -> String {
        guard let product = product(for: plan) else {
            return plan == .weekly ? "$7.99/week" : "$39.99/year"
        }
        return product.displayPrice + (plan == .weekly ? "/week" : "/year")
    }

    // MARK: - Private Methods

    /// Listen for transaction updates (renewals, refunds, etc.)
    private func listenForTransactions() -> Task<Void, Error> {
        Task.detached {
            for await result in Transaction.updates {
                // Verify and handle on main actor
                await MainActor.run {
                    Task {
                        do {
                            let transaction = try self.checkVerified(result)

                            // Update subscription status
                            await self.updateSubscriptionStatus()

                            // Finish the transaction
                            await transaction.finish()
                        } catch {
                            print("[StoreKit] Transaction verification failed: \(error)")
                        }
                    }
                }
            }
        }
    }

    /// Verify a transaction
    private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified(_, let error):
            print("[StoreKit] Verification failed: \(error)")
            throw StoreError.verificationFailed
        case .verified(let safe):
            return safe
        }
    }

    /// Update the usage tracker with current subscription tier
    private func updateUsageTier() {
        let tier: UsageTier = isPremium ? .pro : .free
        UsageTrackerService.shared.setTier(tier)
    }
}

// MARK: - Product Extensions

extension Product {
    /// Whether this is an annual subscription
    var isAnnual: Bool {
        id.contains("annual")
    }

    /// Weekly price equivalent for comparison
    var weeklyPriceEquivalent: Decimal {
        if isAnnual {
            return price / 52
        }
        return price
    }

    /// Savings percentage compared to weekly plan
    func savingsPercentage(comparedTo weeklyProduct: Product) -> Int {
        let annualWeeklyPrice = weeklyPriceEquivalent
        let weeklyPrice = weeklyProduct.price

        guard weeklyPrice > 0 else { return 0 }

        let savings = (weeklyPrice - annualWeeklyPrice) / weeklyPrice * 100
        return Int(NSDecimalNumber(decimal: savings).doubleValue)
    }
}
