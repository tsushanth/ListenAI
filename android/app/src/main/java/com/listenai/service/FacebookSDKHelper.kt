package com.listenai.service

import android.content.Context
import android.os.Bundle
import android.util.Log
import com.facebook.FacebookSdk
import com.facebook.appevents.AppEventsConstants
import com.facebook.appevents.AppEventsLogger

object FacebookSDKHelper {
    private const val TAG = "FacebookSDKHelper"

    private var logger: AppEventsLogger? = null

    fun initialize(context: Context) {
        try {
            FacebookSdk.sdkInitialize(context.applicationContext)
            FacebookSdk.setAutoLogAppEventsEnabled(true)
            FacebookSdk.setAdvertiserIDCollectionEnabled(true)
            logger = AppEventsLogger.newLogger(context.applicationContext)
            Log.i(TAG, "Facebook SDK initialized")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize Facebook SDK", e)
        }
    }

    fun logSubscription(price: Double, currency: String, productId: String) {
        try {
            val params = Bundle().apply {
                putString(AppEventsConstants.EVENT_PARAM_CONTENT_ID, productId)
                putString(AppEventsConstants.EVENT_PARAM_CURRENCY, currency)
                putInt(AppEventsConstants.EVENT_PARAM_NUM_ITEMS, 1)
            }
            logger?.logPurchase(price.toBigDecimal(), java.util.Currency.getInstance(currency), params)
            logger?.logEvent(AppEventsConstants.EVENT_NAME_SUBSCRIBE, price, params)
            Log.d(TAG, "Logged subscription: $productId $price $currency")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to log subscription", e)
        }
    }

    fun logTrialStarted(productId: String) {
        try {
            val params = Bundle().apply {
                putString(AppEventsConstants.EVENT_PARAM_CONTENT_ID, productId)
                putString(AppEventsConstants.EVENT_PARAM_CURRENCY, "USD")
                putInt(AppEventsConstants.EVENT_PARAM_NUM_ITEMS, 1)
            }
            logger?.logEvent(AppEventsConstants.EVENT_NAME_START_TRIAL, params)
            Log.d(TAG, "Logged trial started: $productId")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to log trial started", e)
        }
    }
}
