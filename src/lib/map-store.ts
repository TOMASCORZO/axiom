import { create } from 'zustand';
import type {
    MapMetadataShape,
    MapIsoTile,
    MapObjectEntry,
    MapObjectPlacement,
    MapMode,
    TerrainCorner,
} from '@/types/asset';

// Tools available to the user. Brush meaning depends on projection:
//   orthogonal → paint a CORNER with the selected terrain label (Wang)
//   isometric  → paint a CELL with the selected iso tile id
export type MapTool = 'paint' | 'erase' | 'place_object' | 'pan';

interface HistoryEntry {
    corners?: TerrainCorner[][];           // ortho
    isoGrid?: (string | null)[][];         // iso
    placements: MapObjectPlacement[];
}

interface MapEditorState {
    assetId: string | null;
    metadata: MapMetadataShape | null;
    dirty: boolean;

    tool: MapTool;
    selectedTerrain: TerrainCorner;        // ortho
    selectedIsoTileId: string | null;      // iso
    selectedObjectId: string | null;
    saving: boolean;
    saveError: string | null;

    history: HistoryEntry[];
    redo: HistoryEntry[];

    // Actions
    open: (assetId: string, metadata: MapMetadataShape) => void;
    close: () => void;
    setTool: (tool: MapTool) => void;
    selectTerrain: (label: TerrainCorner) => void;
    selectIsoTile: (id: string | null) => void;
    selectObject: (id: string | null) => void;

    /** Paint one grid coord.
     * - orthogonal: (x, y) are CORNER coordinates (0..grid_w, 0..grid_h).
     * - isometric:  (x, y) are CELL coordinates (0..grid_w-1, 0..grid_h-1). */
    paintAt: (x: number, y: number) => void;
    eraseAt: (x: number, y: number) => void;

    placeObject: (x: number, y: number, objectId: string) => void;
    removePlacement: (placementId: string) => void;
    extendGrid: (addCols: number, addRows: number) => void;
    setMode: (mode: MapMode) => void;
    addIsoTileToLibrary: (tile: MapIsoTile) => void;
    addObjectToLibrary: (obj: MapObjectEntry) => void;
    undo: () => void;
    redoAction: () => void;
    setSaving: (v: boolean) => void;
    setSaveError: (e: string | null) => void;
    markSaved: () => void;
}

function cloneGrid2D<T>(grid: T[][]): T[][] {
    return grid.map(row => row.slice());
}

function snapshot(meta: MapMetadataShape): HistoryEntry {
    return {
        corners: meta.corners ? cloneGrid2D(meta.corners) : undefined,
        isoGrid: meta.iso_grid ? cloneGrid2D(meta.iso_grid) : undefined,
        placements: meta.placements.map(p => ({ ...p })),
    };
}

export const useMapEditorStore = create<MapEditorState>((set, get) => ({
    assetId: null,
    metadata: null,
    dirty: false,
    tool: 'paint',
    selectedTerrain: 'upper',
    selectedIsoTileId: null,
    selectedObjectId: null,
    saving: false,
    saveError: null,
    history: [],
    redo: [],

    open: (assetId, metadata) => {
        const clone = JSON.parse(JSON.stringify(metadata)) as MapMetadataShape;
        set({
            assetId,
            metadata: clone,
            dirty: false,
            tool: 'paint',
            selectedTerrain: 'upper',
            selectedIsoTileId: clone.iso_tiles?.[0]?.id ?? null,
            selectedObjectId: null,
            history: [],
            redo: [],
            saveError: null,
        });
    },

    close: () => set({
        assetId: null,
        metadata: null,
        dirty: false,
        history: [],
        redo: [],
        saveError: null,
    }),

    setTool: (tool) => set({ tool }),
    selectTerrain: (label) => set({ selectedTerrain: label }),
    selectIsoTile: (id) => set({ selectedIsoTileId: id }),
    selectObject: (id) => set({ selectedObjectId: id }),

    paintAt: (x, y) => {
        const s = get();
        const meta = s.metadata;
        if (!meta) return;
        const before = snapshot(meta);

        if (meta.projection === 'isometric') {
            if (!s.selectedIsoTileId) return;
            if (x < 0 || y < 0 || x >= meta.grid_w || y >= meta.grid_h) return;
            const grid = cloneGrid2D(meta.iso_grid ?? []);
            if (grid[y]?.[x] === s.selectedIsoTileId) return;
            if (!grid[y]) grid[y] = [];
            grid[y][x] = s.selectedIsoTileId;
            set({
                metadata: { ...meta, iso_grid: grid },
                history: [...s.history, before].slice(-100),
                redo: [],
                dirty: true,
            });
            return;
        }

        // Orthogonal: paint a corner
        if (x < 0 || y < 0 || x > meta.grid_w || y > meta.grid_h) return;
        const corners = cloneGrid2D(meta.corners ?? []);
        if (!corners[y]) corners[y] = [];
        if (corners[y][x] === s.selectedTerrain) return;
        corners[y][x] = s.selectedTerrain;
        set({
            metadata: { ...meta, corners },
            history: [...s.history, before].slice(-100),
            redo: [],
            dirty: true,
        });
    },

    eraseAt: (x, y) => {
        const s = get();
        const meta = s.metadata;
        if (!meta) return;
        const before = snapshot(meta);

        if (meta.projection === 'isometric') {
            if (x < 0 || y < 0 || x >= meta.grid_w || y >= meta.grid_h) return;
            const grid = cloneGrid2D(meta.iso_grid ?? []);
            if (grid[y]?.[x] == null) return;
            grid[y][x] = null;
            set({
                metadata: { ...meta, iso_grid: grid },
                history: [...s.history, before].slice(-100),
                redo: [],
                dirty: true,
            });
            return;
        }

        // Orthogonal: reset corner to 'lower'
        if (x < 0 || y < 0 || x > meta.grid_w || y > meta.grid_h) return;
        const corners = cloneGrid2D(meta.corners ?? []);
        if (!corners[y]) corners[y] = [];
        if (corners[y][x] === 'lower') return;
        corners[y][x] = 'lower';
        set({
            metadata: { ...meta, corners },
            history: [...s.history, before].slice(-100),
            redo: [],
            dirty: true,
        });
    },

    placeObject: (x, y, objectId) => {
        const s = get();
        if (!s.metadata) return;
        const before = snapshot(s.metadata);
        const placements = [
            ...s.metadata.placements,
            { id: crypto.randomUUID(), object_id: objectId, grid_x: x, grid_y: y },
        ];
        set({
            metadata: { ...s.metadata, placements },
            history: [...s.history, before].slice(-100),
            redo: [],
            dirty: true,
        });
    },

    removePlacement: (placementId) => {
        const s = get();
        if (!s.metadata) return;
        const before = snapshot(s.metadata);
        const placements = s.metadata.placements.filter(p => p.id !== placementId);
        set({
            metadata: { ...s.metadata, placements },
            history: [...s.history, before].slice(-100),
            redo: [],
            dirty: true,
        });
    },

    extendGrid: (addCols, addRows) => {
        const s = get();
        const meta = s.metadata;
        if (!meta) return;
        const before = snapshot(meta);
        const newW = Math.max(1, meta.grid_w + addCols);
        const newH = Math.max(1, meta.grid_h + addRows);

        let patch: Partial<MapMetadataShape>;
        if (meta.projection === 'isometric') {
            const old = meta.iso_grid ?? [];
            const grid: (string | null)[][] = [];
            for (let y = 0; y < newH; y++) {
                const row: (string | null)[] = [];
                for (let x = 0; x < newW; x++) row.push(old[y]?.[x] ?? null);
                grid.push(row);
            }
            patch = { iso_grid: grid };
        } else {
            const old = meta.corners ?? [];
            const corners: TerrainCorner[][] = [];
            for (let y = 0; y <= newH; y++) {
                const row: TerrainCorner[] = [];
                for (let x = 0; x <= newW; x++) row.push(old[y]?.[x] ?? 'lower');
                corners.push(row);
            }
            patch = { corners };
        }

        set({
            metadata: { ...meta, grid_w: newW, grid_h: newH, ...patch },
            history: [...s.history, before].slice(-100),
            redo: [],
            dirty: true,
        });
    },

    setMode: (mode) => {
        const s = get();
        if (!s.metadata) return;
        if (s.metadata.mode === mode) return;
        set({ metadata: { ...s.metadata, mode }, dirty: true });
    },

    addIsoTileToLibrary: (tile) => {
        const s = get();
        if (!s.metadata) return;
        const iso_tiles = [...(s.metadata.iso_tiles ?? []), tile];
        set({
            metadata: { ...s.metadata, iso_tiles },
            selectedIsoTileId: tile.id,
            dirty: true,
        });
    },

    addObjectToLibrary: (obj) => {
        const s = get();
        if (!s.metadata) return;
        set({
            metadata: {
                ...s.metadata,
                objects_library: [...s.metadata.objects_library, obj],
            },
            selectedObjectId: obj.id,
            dirty: true,
        });
    },

    undo: () => {
        const s = get();
        if (!s.metadata || s.history.length === 0) return;
        const last = s.history[s.history.length - 1];
        const current = snapshot(s.metadata);
        const patch: Partial<MapMetadataShape> = {
            placements: last.placements,
        };
        if (last.corners) patch.corners = last.corners;
        if (last.isoGrid) patch.iso_grid = last.isoGrid;
        set({
            metadata: { ...s.metadata, ...patch },
            history: s.history.slice(0, -1),
            redo: [...s.redo, current],
            dirty: true,
        });
    },

    redoAction: () => {
        const s = get();
        if (!s.metadata || s.redo.length === 0) return;
        const next = s.redo[s.redo.length - 1];
        const current = snapshot(s.metadata);
        const patch: Partial<MapMetadataShape> = {
            placements: next.placements,
        };
        if (next.corners) patch.corners = next.corners;
        if (next.isoGrid) patch.iso_grid = next.isoGrid;
        set({
            metadata: { ...s.metadata, ...patch },
            history: [...s.history, current],
            redo: s.redo.slice(0, -1),
            dirty: true,
        });
    },

    setSaving: (v) => set({ saving: v }),
    setSaveError: (e) => set({ saveError: e }),
    markSaved: () => set({ dirty: false, saveError: null }),
}));
