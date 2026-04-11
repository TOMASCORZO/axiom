import { create } from 'zustand';
import type {
    MapMetadataShape,
    MapTileEntry,
    MapObjectEntry,
    MapObjectPlacement,
    MapMode,
} from '@/types/asset';

export type MapTool = 'paint' | 'erase' | 'place_object' | 'pan';

interface HistoryEntry {
    grid: (string | null)[][];
    placements: MapObjectPlacement[];
}

interface MapEditorState {
    // What the editor is currently editing
    assetId: string | null;
    metadata: MapMetadataShape | null;
    dirty: boolean;

    // Interaction state
    tool: MapTool;
    selectedTileId: string | null;
    selectedObjectId: string | null;
    saving: boolean;
    saveError: string | null;

    // Undo stack: snapshots BEFORE each edit. Redo is rebuilt when we push.
    history: HistoryEntry[];
    redo: HistoryEntry[];

    // Actions
    open: (assetId: string, metadata: MapMetadataShape) => void;
    close: () => void;
    setTool: (tool: MapTool) => void;
    selectTile: (id: string | null) => void;
    selectObject: (id: string | null) => void;
    paintCell: (x: number, y: number, tileId: string | null) => void;
    eraseCell: (x: number, y: number) => void;
    placeObject: (x: number, y: number, objectId: string) => void;
    removePlacement: (placementId: string) => void;
    extendGrid: (addCols: number, addRows: number) => void;
    setMode: (mode: MapMode) => void;
    addTileToLibrary: (tile: MapTileEntry) => void;
    addObjectToLibrary: (obj: MapObjectEntry) => void;
    undo: () => void;
    redoAction: () => void;
    setSaving: (v: boolean) => void;
    setSaveError: (e: string | null) => void;
    markSaved: () => void;
}

function cloneGrid(grid: (string | null)[][]): (string | null)[][] {
    return grid.map(row => row.slice());
}

function snapshot(meta: MapMetadataShape): HistoryEntry {
    return {
        grid: cloneGrid(meta.grid),
        placements: meta.placements.map(p => ({ ...p })),
    };
}

export const useMapEditorStore = create<MapEditorState>((set, get) => ({
    assetId: null,
    metadata: null,
    dirty: false,
    tool: 'paint',
    selectedTileId: null,
    selectedObjectId: null,
    saving: false,
    saveError: null,
    history: [],
    redo: [],

    open: (assetId, metadata) => set({
        assetId,
        metadata: JSON.parse(JSON.stringify(metadata)) as MapMetadataShape,
        dirty: false,
        tool: 'paint',
        selectedTileId: metadata.tiles[0]?.id ?? null,
        selectedObjectId: null,
        history: [],
        redo: [],
        saveError: null,
    }),

    close: () => set({
        assetId: null,
        metadata: null,
        dirty: false,
        history: [],
        redo: [],
        saveError: null,
    }),

    setTool: (tool) => set({ tool }),
    selectTile: (id) => set({ selectedTileId: id }),
    selectObject: (id) => set({ selectedObjectId: id }),

    paintCell: (x, y, tileId) => {
        const s = get();
        if (!s.metadata) return;
        const { grid_w, grid_h } = s.metadata;
        if (x < 0 || y < 0 || x >= grid_w || y >= grid_h) return;
        const before = snapshot(s.metadata);
        const grid = cloneGrid(s.metadata.grid);
        if (grid[y][x] === tileId) return; // no-op
        grid[y][x] = tileId;
        set({
            metadata: { ...s.metadata, grid },
            history: [...s.history, before].slice(-100),
            redo: [],
            dirty: true,
        });
    },

    eraseCell: (x, y) => {
        const s = get();
        if (!s.metadata) return;
        if (s.metadata.grid[y]?.[x] == null) return;
        const before = snapshot(s.metadata);
        const grid = cloneGrid(s.metadata.grid);
        grid[y][x] = null;
        set({
            metadata: { ...s.metadata, grid },
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
        if (!s.metadata) return;
        const before = snapshot(s.metadata);
        const newW = Math.max(1, s.metadata.grid_w + addCols);
        const newH = Math.max(1, s.metadata.grid_h + addRows);

        const oldGrid = s.metadata.grid;
        const grid: (string | null)[][] = [];
        for (let y = 0; y < newH; y++) {
            const row: (string | null)[] = [];
            for (let x = 0; x < newW; x++) {
                row.push(oldGrid[y]?.[x] ?? null);
            }
            grid.push(row);
        }

        set({
            metadata: {
                ...s.metadata,
                grid_w: newW,
                grid_h: newH,
                grid,
            },
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

    addTileToLibrary: (tile) => {
        const s = get();
        if (!s.metadata) return;
        set({
            metadata: { ...s.metadata, tiles: [...s.metadata.tiles, tile] },
            selectedTileId: tile.id,
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
        set({
            metadata: { ...s.metadata, grid: last.grid, placements: last.placements },
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
        set({
            metadata: { ...s.metadata, grid: next.grid, placements: next.placements },
            history: [...s.history, current],
            redo: s.redo.slice(0, -1),
            dirty: true,
        });
    },

    setSaving: (v) => set({ saving: v }),
    setSaveError: (e) => set({ saveError: e }),
    markSaved: () => set({ dirty: false, saveError: null }),
}));
