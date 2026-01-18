package com.listenai.data.remote

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

/**
 * API client for ListenAI backend
 */
class ApiClient(
    private val baseUrl: String = "https://api.listenai.app/"
) {

    private var authToken: String? = null

    private val loggingInterceptor = HttpLoggingInterceptor().apply {
        level = HttpLoggingInterceptor.Level.BODY
    }

    private val authInterceptor = Interceptor { chain ->
        val original = chain.request()
        val builder = original.newBuilder()

        authToken?.let { token ->
            builder.addHeader("Authorization", "Bearer $token")
        }

        builder.addHeader("Content-Type", "application/json")
        builder.addHeader("Accept", "application/json")
        builder.addHeader("User-Agent", "ListenAI-Android/1.0")

        chain.proceed(builder.build())
    }

    private val okHttpClient = OkHttpClient.Builder()
        .addInterceptor(authInterceptor)
        .addInterceptor(loggingInterceptor)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val retrofit = Retrofit.Builder()
        .baseUrl(baseUrl)
        .client(okHttpClient)
        .addConverterFactory(GsonConverterFactory.create())
        .build()

    val api: ListenAIApi = retrofit.create(ListenAIApi::class.java)

    /**
     * Set the authentication token
     */
    fun setAuthToken(token: String?) {
        authToken = token
    }

    /**
     * Get current auth token
     */
    fun getAuthToken(): String? = authToken

    /**
     * Check if user is authenticated
     */
    fun isAuthenticated(): Boolean = authToken != null

    companion object {
        @Volatile
        private var instance: ApiClient? = null

        fun getInstance(baseUrl: String = "https://api.listenai.app/"): ApiClient {
            return instance ?: synchronized(this) {
                instance ?: ApiClient(baseUrl).also { instance = it }
            }
        }
    }
}
