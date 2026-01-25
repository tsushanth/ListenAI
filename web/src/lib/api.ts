// API Service for Voice Marketplace

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend-917362189743.us-central1.run.app';

// Get or create device ID for user identification
function getDeviceId(): string {
  if (typeof window === 'undefined') return '';

  let deviceId = localStorage.getItem('deviceId');
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem('deviceId', deviceId);
  }
  return deviceId;
}

// API request helper
async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-ID': getDeviceId(),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

// Types
export interface SharedVoice {
  id: string;
  display_name: string;
  description: string | null;
  tags: string[];
  preview_audio_url: string | null;
  preview_duration_sec: number | null;
  usage_count: number;
  avg_rating: number;
  rating_count: number;
  owner_user_id: string;
  created_at: string;
  is_own: boolean;
}

export interface MySharedVoice {
  id: string;
  display_name: string;
  description: string | null;
  tags: string[];
  status: 'active' | 'suspended' | 'revoked' | 'pending_review';
  usage_count: number;
  avg_rating: number;
  rating_count: number;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface ClonedVoice {
  id: string;
  name: string;
  description: string | null;
  audio_path: string;
  audio_url: string | null;
  duration_sec: number | null;
  exaggeration: number;
  is_default: boolean;
  usage_count: number;
  created_at: string;
}

export interface RewardsSummary {
  pending: {
    minutes: number;
    count: number;
  };
  credited: {
    total_minutes: number;
  };
}

export interface RewardHistoryEntry {
  id: string;
  shared_voice_id: string;
  voice_name: string;
  characters_generated: number;
  seconds_generated: number;
  reward_minutes: number;
  credited: boolean;
  credited_at: string | null;
  created_at: string;
}

export type SortOption = 'popular' | 'newest' | 'rating';
export type ReportReason = 'not_their_voice' | 'celebrity' | 'public_figure' | 'offensive' | 'copyright' | 'other';

// Marketplace API
export const marketplaceApi = {
  // Browse voices
  async browse(params: {
    tags?: string[];
    search?: string;
    sort?: SortOption;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ voices: SharedVoice[] }> {
    const queryParams = new URLSearchParams();
    if (params.tags?.length) queryParams.set('tags', params.tags.join(','));
    if (params.search) queryParams.set('search', params.search);
    if (params.sort) queryParams.set('sort', params.sort);
    if (params.limit) queryParams.set('limit', String(params.limit));
    if (params.offset) queryParams.set('offset', String(params.offset));

    const query = queryParams.toString();
    return apiRequest(`/api/marketplace${query ? `?${query}` : ''}`);
  },

  // Get single voice
  async getVoice(id: string): Promise<SharedVoice> {
    return apiRequest(`/api/marketplace/${id}`);
  },

  // Share a voice
  async shareVoice(data: {
    cloned_voice_id: string;
    display_name: string;
    description?: string;
    tags?: string[];
    owner_attestation: string;
    terms_accepted: boolean;
  }): Promise<{ id: string }> {
    return apiRequest('/api/marketplace/share', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Revoke a voice
  async revokeVoice(id: string): Promise<void> {
    await apiRequest(`/api/marketplace/${id}`, { method: 'DELETE' });
  },

  // Rate a voice
  async rateVoice(id: string, rating: number, review?: string): Promise<void> {
    await apiRequest(`/api/marketplace/${id}/rate`, {
      method: 'POST',
      body: JSON.stringify({ rating, review }),
    });
  },

  // Report a voice
  async reportVoice(id: string, reason: ReportReason, description: string): Promise<void> {
    await apiRequest(`/api/marketplace/${id}/report`, {
      method: 'POST',
      body: JSON.stringify({ reason, description }),
    });
  },

  // Get my shared voices
  async getMyShares(): Promise<{ shares: MySharedVoice[] }> {
    return apiRequest('/api/marketplace/my/shares');
  },

  // Get rewards summary
  async getRewardsSummary(): Promise<RewardsSummary> {
    return apiRequest('/api/marketplace/my/rewards');
  },

  // Credit rewards
  async creditRewards(): Promise<{ credited_minutes: number }> {
    return apiRequest('/api/marketplace/my/rewards/credit', { method: 'POST' });
  },

  // Get reward history
  async getRewardHistory(limit = 50, offset = 0): Promise<{ history: RewardHistoryEntry[] }> {
    return apiRequest(`/api/marketplace/my/rewards/history?limit=${limit}&offset=${offset}`);
  },
};

// Cloned Voices API
export const clonedVoicesApi = {
  // List user's cloned voices
  async list(): Promise<{ voices: ClonedVoice[] }> {
    return apiRequest('/api/cloned-voices');
  },

  // Get single voice
  async get(id: string): Promise<ClonedVoice> {
    return apiRequest(`/api/cloned-voices/${id}`);
  },

  // Delete a voice
  async delete(id: string): Promise<void> {
    await apiRequest(`/api/cloned-voices/${id}`, { method: 'DELETE' });
  },
};

// TTS API
export const ttsApi = {
  // Synthesize text
  async synthesize(data: {
    text: string;
    voice_id?: string;
    speed?: number;
    format?: 'mp3' | 'wav';
  }): Promise<Blob> {
    const response = await fetch(`${API_BASE_URL}/api/synthesize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-ID': getDeviceId(),
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error('Synthesis failed');
    }

    return response.blob();
  },
};
