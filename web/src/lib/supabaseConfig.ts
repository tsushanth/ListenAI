// This app has no NEXT_PUBLIC_* build-arg wiring in its Dockerfile (see api.ts's
// NEXT_PUBLIC_API_URL for the same existing pattern) — hardcoded fallbacks are safe
// here because the anon key is explicitly designed to be public/client-exposed,
// unlike the service-role key used server-side in the backend.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://qtfoqroezsdznbimeopj.supabase.co'
export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF0Zm9xcm9lenNkem5iaW1lb3BqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc0NDQ5NjYsImV4cCI6MjA4MzAyMDk2Nn0.8xooGYaiVv3seyZfNmykMWLtf8waY5hPcsAhINqlYs0'

