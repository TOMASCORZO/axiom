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
//   isometric  → paint the BASE tile (index 0) of the cell's iso_stack
// Iso-only tools:
//   stack_add  → push the selected iso tile on top of the cell's stack
//   stack_pop  → pop the top tile from the cell's stack
export type MapTool = 'paint' | 'erase' | 'place_object' | 'pan' | 'stack_add' | 'stack_pop';

/** Uniform vertical step per stack level, expressed as a fraction of tile_size. */
export const STACK_STEP_RATIO = 0.5;

interface HistoryEntry {
    corners?: TerrainCorner[][];           // ortho
    isoStack?: string[][][];               // iso (stacked)
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
    /** Place a project asset (sprite / animation / sprite sheet) onto the map via drag-drop. */
    placeAsset: (x: number, y: number, assetId: string, zLevel?: number) => void;
    removePlacement: (placementId: string) => void;
    /** Iso only: push the selected iso tile onto the stack at (x,y). */
    stackAdd: (x: number, y: number) => void;
    /** Iso only: pop the top tile of the stack at (x,y). */
    stackPop: (x: number, y: number) => void;
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

function cloneStack(stack: string[][][]): string[][][] {
    return stack.map(row => row.map(cell => cell.slice()));
}

/** Build an empty iso stack of the given size. */
function emptyStack(w: number, h: number): string[][][] {
    return Array.from({ length: h }, () => Array.from({ length: w }, () => [] as string[]));
}

/** Migrate legacy iso_grid (single tile per cell) to iso_stack (array per cell). */
function migrateIsoGridToStack(meta: MapMetadataShape): string[][][] {
    if (meta.iso_stack && meta.iso_stack.length > 0) return meta.iso_stack;
    const stack = emptyStack(meta.grid_w, meta.grid_h);
    const grid = meta.iso_grid ?? [];
    for (let y = 0; y < meta.grid_h; y++) {
        for (let x = 0; x < meta.grid_w; x++) {
            const id = grid[y]?.[x];
            if (id) stack[y][x] = [id];
        }
    }
    return stack;
}

function snapshot(meta: MapMetadataShape): HistoryEntry {
    return {
        corners: meta.corners ? cloneGrid2D(meta.corners) : undefined,
        isoStack: meta.iso_stack ? cloneStack(meta.iso_stack) : undefined,
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
        // Ensure iso_stack is populated — migrate from legacy iso_grid on first open.
        if (clone.projection === 'isometric') {
            clone.iso_stack = migrateIsoGridToStack(clone);
        }
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

    setTool: (tool) => {
        const s = get();
        // Auto-select the first library object if switching to place_object
        // with nothing selected, so the tool is usable immediately after a
        // page reload (selectedObjectId resets to null on re-open).
        if (tool === 'place_object' && !s.selectedObjectId) {
            const first = s.metadata?.objects_library?.[0];
            if (first) {
                set({ tool, selectedObjectId: first.id });
                return;
            }
        }
        set({ tool });
    },
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
            const stack = cloneStack(meta.iso_stack ?? migrateIsoGridToStack(meta));
            const cell = stack[y]?.[x] ?? [];
            // Paint sets the BASE tile (index 0). Preserves any higher levels.
            if (cell[0] === s.selectedIsoTileId) return;
            if (cell.length === 0) stack[y][x] = [s.selectedIsoTileId];
            else stack[y][x] = [s.selectedIsoTileId, ...cell.slice(1)];
            set({
                metadata: { ...meta, iso_stack: stack },
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
            const stack = cloneStack(meta.iso_stack ?? migrateIsoGridToStack(meta));
            if ((stack[y]?.[x]?.length ?? 0) === 0) return;
            // Erase clears the entire stack for this cell.
            stack[y][x] = [];
            set({
                metadata: { ...meta, iso_stack: stack },
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

    stackAdd: (x, y) => {
        const s = get();
        const meta = s.metadata;
        if (!meta || meta.projection !== 'isometric') return;
        if (!s.selectedIsoTileId) return;
        if (x < 0 || y < 0 || x >= meta.grid_w || y >= meta.grid_h) return;
        const before = snapshot(meta);
        const stack = cloneStack(meta.iso_stack ?? migrateIsoGridToStack(meta));
        stack[y][x] = [...(stack[y][x] ?? []), s.selectedIsoTileId];
        set({
            metadata: { ...meta, iso_stack: stack },
            history: [...s.history, before].slice(-100),
            redo: [],
            dirty: true,
        });
    },

    stackPop: (x, y) => {
        const s = get();
        const meta = s.metadata;
        if (!meta || meta.projection !== 'isometric') return;
        if (x < 0 || y < 0 || x >= meta.grid_w || y >= meta.grid_h) return;
        const before = snapshot(meta);
        const stack = cloneStack(meta.iso_stack ?? migrateIsoGridToStack(meta));
        const cell = stack[y]?.[x] ?? [];
        if (cell.length === 0) return;
        stack[y][x] = cell.slice(0, -1);
        set({
            metadata: { ...meta, iso_stack: stack },
            history: [...s.history, before].slice(-100),
            redo: [],
            dirty: true,
        });
    },

    placeObject: (x, y, objectId) => {
        const s = get();
        const meta = s.metadata;
        if (!meta) return;
        const before = snapshot(meta);
        // Default iso z_level: sit on top of whatever stack is at (x,y).
        const zLevel = meta.projection === 'isometric'
            ? (meta.iso_stack?.[y]?.[x]?.length ?? 0)
            : undefined;
        const placements = [
            ...meta.placements,
            { id: crypto.randomUUID(), object_id: objectId, grid_x: x, grid_y: y, z_level: zLevel },
        ];
        set({
            metadata: { ...meta, placements },
            history: [...s.history, before].slice(-100),
            redo: [],
            dirty: true,
        });
    },

    placeAsset: (x, y, assetId, zLevel) => {
        const s = get();
        const meta = s.metadata;
        if (!meta) return;
        if (x < 0 || y < 0 || x >= meta.grid_w || y >= meta.grid_h) return;
        const before = snapshot(meta);
        // Default iso z_level: sit on top of the cell's current stack.
        const effectiveZ = zLevel ?? (meta.projection === 'isometric'
            ? (meta.iso_stack?.[y]?.[x]?.length ?? 0)
            : undefined);
        const placements = [
            ...meta.placements,
            { id: crypto.randomUUID(), asset_id: assetId, grid_x: x, grid_y: y, z_level: effectiveZ },
        ];
        set({
            metadata: { ...meta, placements },
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
            const old = meta.iso_stack ?? migrateIsoGridToStack(meta);
            const stack: string[][][] = [];
            for (let y = 0; y < newH; y++) {
                const row: string[][] = [];
                for (let x = 0; x < newW; x++) row.push((old[y]?.[x] ?? []).slice());
                stack.push(row);
            }
            patch = { iso_stack: stack };
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
        if (last.isoStack) patch.iso_stack = last.isoStack;
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
        if (next.isoStack) patch.iso_stack = next.isoStack;
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
