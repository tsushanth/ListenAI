package com.listenai.data.remote

import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.*

/**
 * TTS synthesis request
 */
data class SynthesisRequest(
    val text: String,
    val voice_id: String,
    val provider: String,
    val format: String = "mp3"
)

/**
 * Voice data from API
 */
data class VoiceResponse(
    val id: String,
    val name: String,
    val language: String,
    val provider: String,
    val tier: String,
    val cloud_id: String?,
    val preview_url: String?
)

/**
 * Voices list response
 */
data class VoicesResponse(
    val voices: List<VoiceResponse>
)

/**
 * Usage data from API
 */
data class UsageResponse(
    val total_characters: Int,
    val total_requests: Int,
    val period_start: Long,
    val period_end: Long,
    val limit: Int,
    val tier: String
)

/**
 * User profile response
 */
data class UserProfileResponse(
    val id: String,
    val email: String,
    val name: String?,
    val subscription_tier: String,
    val subscription_status: String
)

/**
 * Health check response
 */
data class HealthResponse(
    val status: String,
    val version: String
)

/**
 * Retrofit API interface for ListenAI backend
 */
interface ListenAIApi {

    /**
     * Health check endpoint
     */
    @GET("api/health")
    suspend fun healthCheck(): Response<HealthResponse>

    /**
     * Synthesize text to speech
     */
    @POST("api/tts/synthesize")
    suspend fun synthesize(
        @Body request: SynthesisRequest
    ): Response<ResponseBody>

    /**
     * Get available voices
     */
    @GET("api/voices")
    suspend fun getVoices(): Response<VoicesResponse>

    /**
     * Get current usage
     */
    @GET("api/usage")
    suspend fun getUsage(): Response<UsageResponse>

    /**
     * Get user profile
     */
    @GET("api/user/profile")
    suspend fun getUserProfile(): Response<UserProfileResponse>

    /**
     * Refresh authentication token
     */
    @POST("api/auth/refresh")
    suspend fun refreshToken(
        @Header("Authorization") refreshToken: String
    ): Response<TokenResponse>
}

/**
 * Token response
 */
data class TokenResponse(
    val access_token: String,
    val refresh_token: String,
    val expires_in: Long
)
