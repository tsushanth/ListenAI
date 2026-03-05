package com.listenai.service.billing

import android.app.Activity
import android.app.Application
import android.util.Log
import com.listenai.service.FirebaseAnalyticsHelper
import com.listenai.service.TikTokHelper
import com.revenuecat.purchases.CustomerInfo
import com.revenuecat.purchases.LogLevel
import com.revenuecat.purchases.Offering
import com.revenuecat.purchases.Package
import com.revenuecat.purchases.PackageType
import com.revenuecat.purchases.PurchaseParams
import com.revenuecat.purchases.Purchases
import com.revenuecat.purchases.PurchasesConfiguration
import com.revenuecat.purchases.PurchasesException
import com.revenuecat.purchases.awaitCustomerInfo
import com.revenuecat.purchases.awaitOfferings
import com.revenuecat.purchases.awaitPurchase
import com.revenuecat.purchases.awaitRestore
import com.revenuecat.purchases.interfaces.UpdatedCustomerInfoListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Manages subscriptions via RevenueCat for Android
 * Mirrors iOS RevenueCatManager functionality
 */
class RevenueCatManager private constructor() : UpdatedCustomerInfoListener {

    companion object {
        private const val TAG = "RevenueCatManager"

        /** RevenueCat API key for Android - from RevenueCat dashboard */
        private const val API_KEY = "goog_OlELFKhofRDLdDUfaZIYctVOVpi"

        /** Entitlement identifier for premium access */
        private const val PREMIUM_ENTITLEMENT_ID = "premium"

        @Volatile
        private var instance: RevenueCatManager? = null

        fun getInstance(): RevenueCatManager {
            return instance ?: synchronized(this) {
                instance ?: RevenueCatManager().also { instance = it }
            }
        }
    }

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    // MARK: - State

    private val _customerInfo = MutableStateFlow<CustomerInfo?>(null)
    val customerInfo: StateFlow<CustomerInfo?> = _customerInfo.asStateFlow()

    private val _isPremium = MutableStateFlow(false)
    val isPremium: StateFlow<Boolean> = _isPremium.asStateFlow()

    private val _packages = MutableStateFlow<List<Package>>(emptyList())
    val packages: StateFlow<List<Package>> = _packages.asStateFlow()

    private val _currentOffering = MutableStateFlow<Offering?>(null)
    val currentOffering: StateFlow<Offering?> = _currentOffering.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    private var isConfigured = false

    // MARK: - Configuration

    /**
     * Configure RevenueCat SDK - call this at app launch in Application.onCreate()
     */
    fun configure(application: Application) {
        if (isConfigured) {
            Log.w(TAG, "RevenueCat already configured")
            return
        }

        Log.d(TAG, "Configuring RevenueCat...")

        Purchases.logLevel = LogLevel.DEBUG // Set to WARN for production

        val configuration = PurchasesConfiguration.Builder(application, API_KEY)
            .build()

        Purchases.configure(configuration)
        Purchases.sharedInstance.updatedCustomerInfoListener = this

        isConfigured = true

        // Fetch initial data
        scope.launch {
            refreshCustomerInfo()
            loadOfferings()
        }

        Log.d(TAG, "RevenueCat configured successfully")
    }

    // MARK: - Customer Info

    /**
     * Refresh customer info from RevenueCat
     */
    suspend fun refreshCustomerInfo() {
        try {
            val info = Purchases.sharedInstance.awaitCustomerInfo()
            updateCustomerInfo(info)
            Log.d(TAG, "Customer info refreshed. Premium: ${_isPremium.value}")
        } catch (e: PurchasesException) {
            Log.e(TAG, "Failed to get customer info: ${e.message}")
        }
    }

    private fun updateCustomerInfo(info: CustomerInfo) {
        _customerInfo.value = info
        val premium = info.entitlements[PREMIUM_ENTITLEMENT_ID]?.isActive == true
        _isPremium.value = premium
    }

    // MARK: - Offerings

    /**
     * Load available offerings/packages
     */
    suspend fun loadOfferings() {
        _isLoading.value = true

        try {
            val offerings = Purchases.sharedInstance.awaitOfferings()
            val current = offerings.current

            if (current != null) {
                _currentOffering.value = current
                _packages.value = current.availablePackages
                Log.d(TAG, "Loaded ${current.availablePackages.size} packages from '${current.identifier}' offering")

                current.availablePackages.forEach { pkg ->
                    Log.d(TAG, "  - ${pkg.identifier}: ${pkg.product.price.formatted}")
                }
            } else {
                Log.w(TAG, "No current offering available")
            }
        } catch (e: PurchasesException) {
            Log.e(TAG, "Failed to load offerings: ${e.message}")
            _errorMessage.value = "Failed to load subscription options"
        } finally {
            _isLoading.value = false
        }
    }

    // MARK: - Purchases

    /**
     * Purchase a package
     * @return true if purchase was successful, false otherwise
     */
    suspend fun purchase(activity: Activity, pkg: Package): Result<CustomerInfo> {
        _isLoading.value = true
        _errorMessage.value = null

        return try {
            val purchaseParams = PurchaseParams.Builder(activity, pkg).build()
            val result = Purchases.sharedInstance.awaitPurchase(purchaseParams)

            updateCustomerInfo(result.customerInfo)
            Log.d(TAG, "Purchase successful: ${pkg.identifier}")

            // Track purchase events for ad attribution
            val productId = pkg.product.id
            val price = pkg.product.price.amountMicros / 1_000_000.0
            FirebaseAnalyticsHelper.logPurchaseCompleted(productId, price)
            TikTokHelper.trackEvent("purchase_success")

            Result.success(result.customerInfo)
        } catch (e: PurchasesException) {
            Log.e(TAG, "Purchase failed: ${e.message}")

            // Check if user cancelled (error code 1)
            if (e.error.code.code == 1) {
                Log.d(TAG, "User cancelled purchase")
                Result.failure(PurchaseException.UserCancelled)
            } else {
                _errorMessage.value = e.message
                Result.failure(PurchaseException.PurchaseFailed(e.message ?: "Unknown error"))
            }
        } finally {
            _isLoading.value = false
        }
    }

    /**
     * Restore previous purchases
     */
    suspend fun restorePurchases(): Result<CustomerInfo> {
        _isLoading.value = true
        _errorMessage.value = null

        return try {
            val info = Purchases.sharedInstance.awaitRestore()
            updateCustomerInfo(info)

            if (_isPremium.value) {
                Log.d(TAG, "Restored premium subscription")
                Result.success(info)
            } else {
                Log.d(TAG, "No active subscription found")
                _errorMessage.value = "No active subscription found"
                Result.failure(PurchaseException.NoPurchasesFound)
            }
        } catch (e: PurchasesException) {
            Log.e(TAG, "Restore failed: ${e.message}")
            _errorMessage.value = "Failed to restore: ${e.message}"
            Result.failure(PurchaseException.RestoreFailed(e.message ?: "Unknown error"))
        } finally {
            _isLoading.value = false
        }
    }

    // MARK: - Helper Methods

    /** Get the weekly package */
    val weeklyPackage: Package?
        get() = _packages.value.find { it.packageType == PackageType.WEEKLY }

    /** Get the annual package */
    val annualPackage: Package?
        get() = _packages.value.find { it.packageType == PackageType.ANNUAL }

    /** Get the monthly package */
    val monthlyPackage: Package?
        get() = _packages.value.find { it.packageType == PackageType.MONTHLY }

    /**
     * Set user ID for attribution (call after user signs in)
     */
    fun setUserID(userID: String) {
        Purchases.sharedInstance.logIn(
            userID,
            callback = object : com.revenuecat.purchases.interfaces.LogInCallback {
                override fun onReceived(customerInfo: CustomerInfo, created: Boolean) {
                    updateCustomerInfo(customerInfo)
                    Log.d(TAG, "User ID set: $userID")
                }

                override fun onError(error: com.revenuecat.purchases.PurchasesError) {
                    Log.e(TAG, "Failed to set user ID: ${error.message}")
                }
            }
        )
    }

    /**
     * Clear user ID on logout
     */
    fun clearUserID() {
        Purchases.sharedInstance.logOut(
            callback = object : com.revenuecat.purchases.interfaces.ReceiveCustomerInfoCallback {
                override fun onReceived(customerInfo: CustomerInfo) {
                    updateCustomerInfo(customerInfo)
                    Log.d(TAG, "User logged out")
                }

                override fun onError(error: com.revenuecat.purchases.PurchasesError) {
                    Log.e(TAG, "Failed to log out: ${error.message}")
                }
            }
        )
    }

    fun clearError() {
        _errorMessage.value = null
    }

    // MARK: - UpdatedCustomerInfoListener

    override fun onReceived(customerInfo: CustomerInfo) {
        Log.d(TAG, "Customer info updated via listener")
        updateCustomerInfo(customerInfo)
    }
}

// MARK: - Purchase Exceptions

sealed class PurchaseException : Exception() {
    object UserCancelled : PurchaseException() {
        override val message = "Purchase was cancelled"
    }

    data class PurchaseFailed(override val message: String) : PurchaseException()

    object NoPurchasesFound : PurchaseException() {
        override val message = "No active subscription found"
    }

    data class RestoreFailed(override val message: String) : PurchaseException()
}

// MARK: - Package Extensions

/** Human-readable description of the package */
val Package.displayDescription: String
    get() = when (packageType) {
        PackageType.WEEKLY -> "Billed weekly"
        PackageType.MONTHLY -> "Billed monthly"
        PackageType.ANNUAL -> "Best value - Save 90%"
        else -> product.description
    }

/** Whether this package has a free trial */
val Package.hasFreeTrial: Boolean
    get() = product.subscriptionOptions?.freeTrial != null

/** Free trial duration string */
val Package.freeTrialDuration: String?
    get() {
        val trial = product.subscriptionOptions?.freeTrial ?: return null
        val period = trial.freePhase?.billingPeriod ?: return null
        return "${period.value} ${period.unit.name.lowercase()}"
    }
