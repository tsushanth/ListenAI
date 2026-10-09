// Strict admin check for the dashboard endpoint. Deliberately NOT requireAuth (that middleware falls back to a default
// user for empty tokens and skips auth outside production). Same rule as web/src/lib/adminAuth.ts, but with no default
// admin address: an unset ADMIN_EMAILS means nobody is admin.
import { supabase } from './supabaseClient.js';

export interface BearerUser { id: string; email?: string | null; email_confirmed_at?: string | null; identities?: Array<{ provider: string }> | null }
export interface AdminBearerDeps { getUser(token: string): Promise<BearerUser | null>; adminEmails: string[] }

export function adminEmailsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

const defaultDeps = (): AdminBearerDeps => ({
  adminEmails: adminEmailsFromEnv(),
  async getUser(token) {
    const { data, error } = await supabase.auth.getUser(token);
    return error ? null : (data.user as unknown as BearerUser | null);
  },
});

export async function isAdminBearer(authorization: string | undefined, deps: AdminBearerDeps = defaultDeps()): Promise<boolean> {
  if (!authorization?.startsWith('Bearer ')) return false;
  const token = authorization.slice(7).trim();
  if (!token) return false;
  try {
    const user = await deps.getUser(token);
    if (!user?.email || !user.email_confirmed_at) return false;
    if (!(user.identities ?? []).some((i) => i.provider === 'google')) return false;
    return deps.adminEmails.includes(user.email.trim().toLowerCase());
  } catch {
    return false;
  }
}
