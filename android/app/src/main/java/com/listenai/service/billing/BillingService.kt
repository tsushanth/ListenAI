package com.listenai.service.billing

import android.app.Activity
import android.content.Context
import android.util.Log
import com.android.billingclient.api.*
import com.android.billingclient.api.BillingClient.ProductType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

/**
 * Service for managing Google Play Billing subscriptions
 */
class BillingService(
    private val context: Context
) : PurchasesUpdatedListener {

    companion object {
        private const val TAG = "BillingService"

        // Product IDs - These must match what you configure in Google Play Console
        const val PRODUCT_ID_WEEKLY = "readaloud_pro_weekly"
        const val PRODUCT_ID_YEARLY = "readaloud_pro_yearly"

        @Volatile
        private var instance: BillingService? = null

        fun getInstance(context: Context): BillingService {
            return instance ?: synchronized(this) {
                instance ?: BillingService(context.applicationContext).also { instance = it }
            }
        }
    }

    private val scope = CoroutineScope(Dispatchers.Main)

    private val _productDetails = MutableStateFlow<List<ProductDetails>>(emptyList())
    val productDetails: StateFlow<List<ProductDetails>> = _productDetails.asStateFlow()

    private val _purchaseState = MutableStateFlow<PurchaseState>(PurchaseState.NoPurchase)
    val purchaseState: StateFlow<PurchaseState> = _purchaseState.asStateFlow()

    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private var billingClient: BillingClient? = null

    sealed class PurchaseState {
        object NoPurchase : PurchaseState()
        object Purchasing : PurchaseState()
        data class Purchased(val productId: String, val purchaseToken: String) : PurchaseState()
        data class Error(val message: String) : PurchaseState()
    }

    sealed class ConnectionState {
        object Connected : ConnectionState()
        object Connecting : ConnectionState()
        object Disconnected : ConnectionState()
        data class Error(val message: String) : ConnectionState()
    }

    init {
        connectToBilling()
    }

    private fun connectToBilling() {
        Log.d(TAG, "Connecting to billing service...")
        _connectionState.value = ConnectionState.Connecting

        billingClient = BillingClient.newBuilder(context)
            .setListener(this)
            .enablePendingPurchases()
            .build()

        billingClient?.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(billingResult: BillingResult) {
                if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                    Log.d(TAG, "Billing service connected")
                    _connectionState.value = ConnectionState.Connected

                    // Fetch products and check existing purchases
                    scope.launch {
                        fetchProductDetails()
                        checkExistingPurchases()
                    }
                } else {
                    Log.e(TAG, "Billing setup failed: ${billingResult.debugMessage}")
                    _connectionState.value = ConnectionState.Error(billingResult.debugMessage)
                }
            }

            override fun onBillingServiceDisconnected() {
                Log.w(TAG, "Billing service disconnected")
                _connectionState.value = ConnectionState.Disconnected
                // Try to reconnect
                connectToBilling()
            }
        })
    }

    /**
     * Fetch product details from Google Play
     * This includes localized pricing information
     */
    private suspend fun fetchProductDetails() = withContext(Dispatchers.IO) {
        val client = billingClient ?: return@withContext
        if (!client.isReady) {
            Log.w(TAG, "Billing client not ready, cannot fetch products")
            return@withContext
        }

        val productList = listOf(
            QueryProductDetailsParams.Product.newBuilder()
                .setProductId(PRODUCT_ID_WEEKLY)
                .setProductType(ProductType.SUBS)
                .build(),
            QueryProductDetailsParams.Product.newBuilder()
                .setProductId(PRODUCT_ID_YEARLY)
                .setProductType(ProductType.SUBS)
                .build()
        )

        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(productList)
            .build()

        try {
            val result = suspendCancellableCoroutine<List<ProductDetails>> { continuation ->
                client.queryProductDetailsAsync(params) { billingResult, productDetailsList ->
                    if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                        Log.d(TAG, "Fetched ${productDetailsList.size} products")
                        continuation.resume(productDetailsList)
                    } else {
                        Log.e(TAG, "Error fetching products: ${billingResult.debugMessage}")
                        continuation.resume(emptyList())
                    }
                }
            }

            withContext(Dispatchers.Main) {
                _productDetails.value = result
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception fetching products", e)
        }
    }

    /**
     * Check for existing active subscriptions
     */
    private suspend fun checkExistingPurchases() = withContext(Dispatchers.IO) {
        val client = billingClient ?: return@withContext
        if (!client.isReady) return@withContext

        try {
            val params = QueryPurchasesParams.newBuilder()
                .setProductType(ProductType.SUBS)
                .build()

            val purchasesResult = client.queryPurchasesAsync(params)
            val billingResult = purchasesResult.billingResult

            if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                val purchases = purchasesResult.purchasesList
                Log.d(TAG, "Found ${purchases.size} existing purchases")

                // Process active purchases
                purchases.firstOrNull { purchase ->
                    purchase.purchaseState == Purchase.PurchaseState.PURCHASED
                }?.let { purchase ->
                    handlePurchase(purchase)
                } ?: run {
                    withContext(Dispatchers.Main) {
                        _purchaseState.value = PurchaseState.NoPurchase
                    }
                }
            } else {
                Log.e(TAG, "Error querying purchases: ${billingResult.debugMessage}")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception checking purchases", e)
        }
    }

    /**
     * Launch purchase flow for a subscription
     */
    fun launchPurchaseFlow(activity: Activity, productDetails: ProductDetails) {
        val client = billingClient
        if (client == null || !client.isReady) {
            _purchaseState.value = PurchaseState.Error("Billing service not ready")
            return
        }

        // Get the offer token for the subscription (first offer)
        val offerToken = productDetails.subscriptionOfferDetails?.firstOrNull()?.offerToken
        if (offerToken == null) {
            _purchaseState.value = PurchaseState.Error("No subscription offer available")
            return
        }

        val productDetailsParamsList = listOf(
            BillingFlowParams.ProductDetailsParams.newBuilder()
                .setProductDetails(productDetails)
                .setOfferToken(offerToken)
                .build()
        )

        val billingFlowParams = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(productDetailsParamsList)
            .build()

        _purchaseState.value = PurchaseState.Purchasing

        val billingResult = client.launchBillingFlow(activity, billingFlowParams)
        if (billingResult.responseCode != BillingClient.BillingResponseCode.OK) {
            Log.e(TAG, "Error launching billing flow: ${billingResult.debugMessage}")
            _purchaseState.value = PurchaseState.Error(billingResult.debugMessage)
        }
    }

    /**
     * Handle purchase updates from Google Play
     */
    override fun onPurchasesUpdated(
        billingResult: BillingResult,
        purchases: List<Purchase>?
    ) {
        when (billingResult.responseCode) {
            BillingClient.BillingResponseCode.OK -> {
                purchases?.forEach { purchase ->
                    handlePurchase(purchase)
                }
            }
            BillingClient.BillingResponseCode.USER_CANCELED -> {
                Log.d(TAG, "User canceled purchase")
                _purchaseState.value = PurchaseState.NoPurchase
            }
            BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> {
                Log.d(TAG, "Item already owned")
                scope.launch {
                    checkExistingPurchases()
                }
            }
            else -> {
                Log.e(TAG, "Purchase update error: ${billingResult.debugMessage}")
                _purchaseState.value = PurchaseState.Error(
                    billingResult.debugMessage ?: "Unknown error"
                )
            }
        }
    }

    /**
     * Process a purchase (verify and acknowledge)
     */
    private fun handlePurchase(purchase: Purchase) {
        scope.launch {
            if (purchase.purchaseState == Purchase.PurchaseState.PURCHASED) {
                if (!purchase.isAcknowledged) {
                    acknowledgePurchase(purchase)
                }

                val productId = purchase.products.firstOrNull() ?: "unknown"
                Log.d(TAG, "Purchase successful: $productId")

                withContext(Dispatchers.Main) {
                    _purchaseState.value = PurchaseState.Purchased(
                        productId = productId,
                        purchaseToken = purchase.purchaseToken
                    )
                }
            } else if (purchase.purchaseState == Purchase.PurchaseState.PENDING) {
                Log.d(TAG, "Purchase pending")
                withContext(Dispatchers.Main) {
                    _purchaseState.value = PurchaseState.Purchasing
                }
            }
        }
    }

    /**
     * Acknowledge a purchase to finalize it
     */
    private suspend fun acknowledgePurchase(purchase: Purchase) = withContext(Dispatchers.IO) {
        val client = billingClient ?: return@withContext

        try {
            val params = AcknowledgePurchaseParams.newBuilder()
                .setPurchaseToken(purchase.purchaseToken)
                .build()

            val result = suspendCancellableCoroutine<BillingResult> { continuation ->
                client.acknowledgePurchase(params) { billingResult ->
                    continuation.resume(billingResult)
                }
            }

            if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                Log.d(TAG, "Purchase acknowledged")
            } else {
                Log.e(TAG, "Error acknowledging purchase: ${result.debugMessage}")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception acknowledging purchase", e)
        }
    }

    /**
     * Restore purchases (check for existing subscriptions)
     */
    suspend fun restorePurchases(): Boolean = withContext(Dispatchers.IO) {
        checkExistingPurchases()
        return@withContext when (val state = _purchaseState.value) {
            is PurchaseState.Purchased -> true
            else -> false
        }
    }

    /**
     * Get localized price string for a product
     */
    fun getFormattedPrice(productId: String): String? {
        return _productDetails.value
            .find { it.productId == productId }
            ?.subscriptionOfferDetails
            ?.firstOrNull()
            ?.pricingPhases
            ?.pricingPhaseList
            ?.firstOrNull()
            ?.formattedPrice
    }

    /**
     * Check if user has active subscription
     */
    fun hasActiveSubscription(): Boolean {
        return _purchaseState.value is PurchaseState.Purchased
    }

    /**
     * Cleanup resources
     */
    fun endConnection() {
        billingClient?.endConnection()
        billingClient = null
        _connectionState.value = ConnectionState.Disconnected
    }
}
