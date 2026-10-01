import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseConfig';

/**
 * True only for an allowlisted email that signed in with Google and has a confirmed address.
 * The bearer token is verified by Supabase Auth itself (getUser). Email/password signups are
 * excluded on purpose: someone could register the admin address without owning it.
 */
export async function isAdminToken(authorization: string | null): Promise<boolean> {
  if (!authorization?.startsWith('Bearer ')) return false;
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supabase.auth.getUser(authorization.slice(7));
    const user = data?.user;
    if (error || !user?.email || !user.email_confirmed_at) return false;
    if (!(user.identities ?? []).some((i) => i.provider === 'google')) return false;
    const allowed = (process.env.ADMIN_EMAILS || 't.sushanth@gmail.com').split(',').map((e) => e.trim().toLowerCase());
    return allowed.includes(user.email.toLowerCase());
  } catch {
    return false;
  }
}
