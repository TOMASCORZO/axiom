/**
 * Free Asset Search — Searches Kenney, OpenGameArt, and itch.io
 *
 * Extracted from agent tools so both the agent and the Asset Studio UI
 * can share the same search logic.
 */

export interface FreeAssetResult {
    title: string;
    url: string;
    download_url: string | null;
    preview_url: string | null;
    license: string;
    source: string;
    author: string;
}

// ── Kenney (offline catalog) ─────────────────────────────────────────

const KENNEY_PACKS: Array<{ name: string; slug: string; tags: string[]; type: string }> = [
    { name: 'Platformer Characters', slug: 'simplified-platformer-pack', tags: ['platformer', 'character', 'player', 'sprite'], type: 'sprite' },
    { name: 'Toon Characters 1', slug: 'toon-characters-1', tags: ['character', 'toon', 'cartoon', 'sprite'], type: 'sprite' },
    { name: 'Animal Pack Redux', slug: 'animal-pack-redux', tags: ['animal', 'dog', 'cat', 'sprite'], type: 'sprite' },
    { name: 'Space Shooter Redux', slug: 'space-shooter-redux', tags: ['space', 'ship', 'shooter', 'bullet'], type: 'sprite' },
    { name: 'Pixel Platformer', slug: 'pixel-platformer', tags: ['pixel', 'platformer', 'retro', 'tiles'], type: 'sprite' },
    { name: 'Monster Pack', slug: 'monster-pack', tags: ['monster', 'enemy', 'creature', 'rpg'], type: 'sprite' },
    { name: 'Platformer Art Pixel Redux', slug: 'platformer-art-pixel-redux', tags: ['platformer', 'tiles', 'tileset', 'pixel'], type: 'tileset' },
    { name: 'Roguelike RPG Pack', slug: 'roguelike-rpg-pack', tags: ['roguelike', 'rpg', 'dungeon', 'tileset'], type: 'tileset' },
    { name: 'Tiny Town', slug: 'tiny-town', tags: ['town', 'city', 'building', 'tiles', 'top-down'], type: 'tileset' },
    { name: 'Tiny Dungeon', slug: 'tiny-dungeon', tags: ['dungeon', 'cave', 'tiles', 'dark', 'rpg'], type: 'tileset' },
    { name: 'Prototype Textures', slug: 'prototype-textures', tags: ['prototype', 'texture', 'grid', 'material'], type: 'texture' },
    { name: 'Background Elements Redux', slug: 'background-elements-redux', tags: ['background', 'sky', 'clouds', 'parallax'], type: 'background' },
    { name: 'UI Pack', slug: 'ui-pack', tags: ['ui', 'button', 'menu', 'hud', 'icon'], type: 'icon' },
    { name: 'Game Icons', slug: 'game-icons', tags: ['icon', 'item', 'weapon', 'potion', 'sword'], type: 'icon' },
    { name: 'Nature Kit', slug: 'nature-kit', tags: ['nature', 'tree', 'rock', '3d', 'model'], type: 'model_3d' },
    { name: 'Car Kit', slug: 'car-kit', tags: ['car', 'vehicle', 'racing', '3d', 'model'], type: 'model_3d' },
    { name: 'Castle Kit', slug: 'castle-kit', tags: ['castle', 'medieval', 'tower', '3d', 'model'], type: 'model_3d' },
    { name: 'Interface Sounds', slug: 'interface-sounds', tags: ['ui', 'click', 'menu', 'sound'], type: 'sound' },
    { name: 'Impact Sounds', slug: 'impact-sounds', tags: ['impact', 'hit', 'explosion', 'sound'], type: 'sound' },
];

export function searchKenney(query: string, assetType: string): FreeAssetResult[] {
    const keywords = query.toLowerCase().split(/\s+/);
    const scored = KENNEY_PACKS.map(p => {
        let score = 0;
        for (const kw of keywords) {
            if (p.tags.some(t => t.includes(kw) || kw.includes(t))) score += 2;
            if (p.name.toLowerCase().includes(kw)) score += 3;
        }
        if (p.type === assetType) score += 2;
        return { pack: p, score };
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);

    return scored.map(({ pack: p }) => ({
        title: p.name,
        url: `https://kenney.nl/assets/${p.slug}`,
        download_url: `https://kenney.nl/media/pages/assets/${p.slug}/*/content.zip`,
        preview_url: `https://kenney.nl/media/pages/assets/${p.slug}/*/preview.png`,
        license: 'CC0 (Public Domain)',
        source: 'Kenney',
        author: 'Kenney.nl',
    }));
}

// ── OpenGameArt (HTML scrape) ────────────────────────────────────────

export async function searchOpenGameArt(query: string, assetType: string): Promise<FreeAssetResult[]> {
    const typeMap: Record<string, string> = {
        sprite: '2d', texture: '2d', tileset: '2d', sprite_sheet: '2d',
        background: '2d', icon: '2d', model_3d: '3d', sound: 'sounds',
    };
    try {
        const params = new URLSearchParams({ keys: query, type: typeMap[assetType] || '2d' });
        const res = await fetch(`https://opengameart.org/art-search-advanced?${params}`, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return [];
        const html = await res.text();
        const results: FreeAssetResult[] = [];
        const re = /<a href="\/content\/([\w-]+)"[^>]*>([^<]+)<\/a>/g;
        let m; let c = 0;
        while ((m = re.exec(html)) !== null && c < 5) {
            results.push({
                title: m[2].trim(),
                url: `https://opengameart.org/content/${m[1]}`,
                download_url: null,
                preview_url: null,
                license: 'CC0/CC-BY/CC-BY-SA',
                source: 'OpenGameArt',
                author: 'Community',
            });
            c++;
        }
        return results;
    } catch { return []; }
}

// ── itch.io (HTML scrape) ────────────────────────────────────────────

export async function searchItchIo(query: string): Promise<FreeAssetResult[]> {
    try {
        const params = new URLSearchParams({ type: 'game-assets', q: query, 'price-range': 'Free' });
        const res = await fetch(`https://itch.io/search?${params}`, {
            headers: { 'Accept': 'text/html', 'User-Agent': 'Axiom-Engine/1.0' },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return [];
        const html = await res.text();
        const results: FreeAssetResult[] = [];
        const re = /<a href="(https:\/\/[^"]+\.itch\.io\/[^"]+)"[^>]*class="title[^"]*"[^>]*>([^<]+)<\/a>/g;
        let m; let c = 0;
        while ((m = re.exec(html)) !== null && c < 5) {
            results.push({
                title: m[2].trim(),
                url: m[1],
                download_url: null,
                preview_url: null,
                license: 'Varies',
                source: 'itch.io',
                author: m[1].split('.itch.io')[0].replace('https://', ''),
            });
            c++;
        }
        return results;
    } catch { return []; }
}

// ── Combined Search ──────────────────────────────────────────────────

export async function searchFreeAssets(query: string, assetType: string): Promise<FreeAssetResult[]> {
    const [kenneyResults, ogaResults, itchResults] = await Promise.all([
        Promise.resolve(searchKenney(query, assetType)),
        searchOpenGameArt(query, assetType),
        searchItchIo(query),
    ]);

    return [
        ...kenneyResults.map(r => ({ ...r, _priority: 0 })),
        ...ogaResults.map(r => ({ ...r, _priority: 1 })),
        ...itchResults.map(r => ({ ...r, _priority: 2 })),
    ]
        .sort((a, b) => a._priority - b._priority)
        .slice(0, 10)
        .map(({ _priority, ...r }) => r);
}
