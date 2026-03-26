import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _adminClient: SupabaseClient | null = null;

/**
 * Returns a Supabase client using the service role key.
 * Bypasses RLS — use only AFTER validating user auth.
 * Singleton to avoid creating multiple clients.
 */
export function getAdminClient(): SupabaseClient {
    if (_adminClient) return _adminClient;

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
        throw new Error(
            'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
            'Add SUPABASE_SERVICE_ROLE_KEY to your environment variables.'
        );
    }

    _adminClient = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

    return _adminClient;
}
