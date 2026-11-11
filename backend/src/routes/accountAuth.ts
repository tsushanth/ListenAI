// Strict bearer verification for destructive account routes: remote (Supabase decides, so it is correct whichever
// signing-key scheme the project uses), no default-user fallback, no dev-mode bypass.
import { verifyAuthTokenRemote, extractBearerToken } from '../lib/auth.js';

export async function authenticateRemote(authHeader: string | undefined): Promise<{ id: string }> {
  const token = extractBearerToken(authHeader);
  const { userId } = await verifyAuthTokenRemote(token);
  return { id: userId };
}
