/**
 * Upsert + lookup helpers for `public.game_players`.
 *
 * Design choice: same OAuth identity gets a *different* player_id in each
 * game so devs can't trivially correlate users across projects. The unique
 * key is (game_id, provider, provider_user_id) — first sign-in creates the
 * row, subsequent sign-ins return it.
 */

import { getAdminClient } from '@/lib/supabase/admin';

export type Provider = 'anonymous' | 'google' | 'discord' | 'github';

export interface PlayerRow {
    player_id: string;
    game_id: string;
    provider: Provider;
    provider_user_id: string;
    email: string | null;
    display_name: string | null;
    avatar_url: string | null;
    created_at: string;
    last_seen_at: string;
}

export interface UpsertPlayerInput {
    gameId: string;
    provider: Provider;
    providerUserId: string;
    email?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
}

export async function upsertPlayer(input: UpsertPlayerInput): Promise<PlayerRow> {
    const admin = getAdminClient();
    const { data, error } = await admin
        .from('game_players')
        .upsert(
            {
                game_id: input.gameId,
                provider: input.provider,
                provider_user_id: input.providerUserId,
                email: input.email ?? null,
                display_name: input.displayName ?? null,
                avatar_url: input.avatarUrl ?? null,
                last_seen_at: new Date().toISOString(),
            },
            { onConflict: 'game_id,provider,provider_user_id' },
        )
        .select('*')
        .single();

    if (error || !data) throw new Error(error?.message ?? 'Failed to upsert player');
    return data as PlayerRow;
}

export async function getPlayer(playerId: string): Promise<PlayerRow | null> {
    const admin = getAdminClient();
    const { data } = await admin
        .from('game_players')
        .select('*')
        .eq('player_id', playerId)
        .maybeSingle();
    return (data as PlayerRow | null) ?? null;
}
