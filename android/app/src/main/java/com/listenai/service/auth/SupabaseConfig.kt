package com.listenai.service.auth

/**
 * Public Supabase project coordinates used for direct email+password sign-in (GoTrue).
 *
 * Both values are copied verbatim from web/src/lib/supabaseConfig.ts. The anon key is a
 * client-side, public key by design (row access is enforced by RLS); the service-role key must
 * NEVER appear here. To point the app at another project, change them in this one place.
 */
object SupabaseConfig {
    const val SUPABASE_URL = "https://qtfoqroezsdznbimeopj.supabase.co"
    const val SUPABASE_ANON_KEY =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF0Zm9xcm9lenNkem5iaW1lb3BqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc0NDQ5NjYsImV4cCI6MjA4MzAyMDk2Nn0.8xooGYaiVv3seyZfNmykMWLtf8waY5hPcsAhINqlYs0"  // gitleaks:allow (Supabase anon key: public by design, identical to web/src/lib/supabaseConfig.ts)
}
