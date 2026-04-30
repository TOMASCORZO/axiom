/**
 * Axiom → Godot Translation Layer
 *
 * Converts Axiom-branded file formats to Godot 4.x native formats
 * right before sending files to the WASM engine. The user never sees
 * Godot extensions or headers — only the engine does.
 *
 * Mappings:
 *   Extensions:   .scene → .tscn    .axs → .gd    project.axiom → project.godot
 *   Headers:      [axiom_scene …] → [gd_scene …]   [axiom_resource …] → [gd_resource …]
 *   Node types:   Entity2D → Node2D   Entity3D → Node3D
 *   ExtResource:  path-based → id-based (Godot 4.x format)
 *
 * Also injects the AxiomInspector autoload (see runtime/axiom_inspector.ts)
 * into every project so the React app can talk to the live SceneTree via
 * the bidirectional bridge.
 */

import {
    AXIOM_INSPECTOR_AUTOLOAD_NAME,
    AXIOM_INSPECTOR_GD,
    AXIOM_INSPECTOR_PATH,
} from './runtime/axiom_inspector';

// ── Path Translation ──────────────────────────────────────────────

const PATH_EXT_MAP: Array<[RegExp, string]> = [
    [/\.scene$/, '.tscn'],
    [/\.axs$/, '.gd'],
];

/** Translate an Axiom file path to its Godot equivalent. */
export function translatePath(axiomPath: string): string {
    if (axiomPath === 'project.axiom' || axiomPath === 'axiom.project') return 'project.godot';
    let result = axiomPath;
    for (const [re, replacement] of PATH_EXT_MAP) {
        result = result.replace(re, replacement);
    }
    return result;
}

// ── Node Type Translation ─────────────────────────────────────────

const NODE_TYPE_MAP: Record<string, string> = {
    'Entity2D': 'Node2D',
    'Entity3D': 'Node3D',
};

/** Replace Axiom node types with Godot equivalents inside scene content. */
function translateNodeTypes(content: string): string {
    let result = content;
    for (const [axiom, godot] of Object.entries(NODE_TYPE_MAP)) {
        // Match type="Entity2D" in [node ...] declarations
        result = result.replaceAll(`type="${axiom}"`, `type="${godot}"`);
    }
    return result;
}

// ── Script Content Translation ────────────────────────────────────

/** Translate .axs script content — maps `extends Entity2D` → `extends Node2D`, path refs, etc. */
function translateScript(content: string): string {
    let result = content;
    for (const [axiom, godot] of Object.entries(NODE_TYPE_MAP)) {
        result = result.replaceAll(`extends ${axiom}`, `extends ${godot}`);
    }
    // Translate file path references inside preload()/load() calls and string literals
    result = result.replace(/\.axs"/g, '.gd"');
    result = result.replace(/\.axs'/g, ".gd'");
    result = result.replace(/\.scene"/g, '.tscn"');
    result = result.replace(/\.scene'/g, ".tscn'");
    return result;
}

// ── Content Translation ───────────────────────────────────────────

/**
 * Translate file content from Axiom format to Godot 4.x native format.
 * Detects file type by extension and applies the appropriate transform.
 */
export function translateContent(axiomPath: string, content: string): string {
    if (axiomPath === 'project.axiom' || axiomPath === 'axiom.project') {
        return translateProjectConfig(content);
    }
    if (axiomPath.endsWith('.scene')) {
        return translateScene(content);
    }
    if (axiomPath.endsWith('.axs')) {
        return translateScript(content);
    }
    return content;
}

/** Translate project.axiom → project.godot content */
function translateProjectConfig(content: string): string {
    let result = content;
    // Godot 4 requires config_version=5 at the top — inject if missing
    if (!result.includes('config_version=')) {
        // Insert after any leading comments, before the first section
        const firstSection = result.search(/^\[/m);
        if (firstSection > 0) {
            result = result.slice(0, firstSection) + 'config_version=5\n\n' + result.slice(firstSection);
        } else {
            result = 'config_version=5\n\n' + result;
        }
    }
    // Translate legacy [axiom] header to [application]
    result = result.replace(/^\[axiom\]$/m, '[application]');
    // Translate internal scene path references
    result = result.replace(/\.scene"/g, '.tscn"');
    result = result.replace(/\.axs"/g, '.gd"');
    // Safety net: ensure stretch_mode + stretch_aspect are set so games auto-
    // fit any device (phone, tablet, desktop, embedded preview). Without
    // these, Godot renders at the project's native resolution and lets the
    // browser canvas pick up the slack — yielding a tiny image in the corner
    // of phone-sized viewports. Old project files written before
    // create_project_config emitted these get them retroactively here.
    result = injectDisplayDefaults(result);
    // Inject AxiomInspector autoload so the React bridge can talk to the SceneTree
    result = injectInspectorAutoload(result);
    return result;
}

/**
 * Ensure project config has [display] section with sensible stretch defaults.
 * Idempotent — only adds keys that aren't already present.
 */
function injectDisplayDefaults(projectIni: string): string {
    const has = (key: string) => new RegExp(`^${escapeRegExp(key)}\\s*=`, 'm').test(projectIni);
    const hasDisplaySection = /^\[display\]\s*$/m.test(projectIni);

    const additions: string[] = [];
    if (!has('window/stretch/mode')) additions.push('window/stretch/mode="canvas_items"');
    if (!has('window/stretch/aspect')) additions.push('window/stretch/aspect="keep"');

    if (additions.length === 0) return projectIni;

    if (hasDisplaySection) {
        // Append our additions right after [display].
        return projectIni.replace(/^\[display\]\s*$/m, `[display]\n${additions.join('\n')}`);
    }
    // No [display] section — add one. Place after the first existing section
    // or at the end.
    const block = `\n[display]\n${additions.join('\n')}\n`;
    return projectIni.trimEnd() + '\n' + block;
}

/**
 * Make sure project.godot registers the AxiomInspector autoload.
 *
 * Adds:
 *   [autoload]
 *   AxiomInspector="*res://addons/axiom/inspector.gd"
 *
 * Idempotent — if the section/key already exists with the right value, no-op.
 * If [autoload] exists with other autoloads, prepend ours to that section.
 */
function injectInspectorAutoload(projectIni: string): string {
    const key = AXIOM_INSPECTOR_AUTOLOAD_NAME;
    const value = `"*res://${AXIOM_INSPECTOR_PATH}"`;
    const line = `${key}=${value}`;

    // Already registered with correct value — nothing to do.
    if (new RegExp(`^${key}\\s*=\\s*"\\*res://${escapeRegExp(AXIOM_INSPECTOR_PATH)}"`, 'm').test(projectIni)) {
        return projectIni;
    }

    // Replace an existing AxiomInspector= line that points elsewhere.
    if (new RegExp(`^${key}\\s*=`, 'm').test(projectIni)) {
        return projectIni.replace(new RegExp(`^${key}\\s*=.*$`, 'm'), line);
    }

    // [autoload] section already exists — append our key under it.
    if (/^\[autoload\]\s*$/m.test(projectIni)) {
        return projectIni.replace(/^\[autoload\]\s*$/m, `[autoload]\n${line}`);
    }

    // No [autoload] section — append a new one.
    const trailingNl = projectIni.endsWith('\n') ? '' : '\n';
    return `${projectIni}${trailingNl}\n[autoload]\n${line}\n`;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Translate .scene → .tscn content (Axiom scene → Godot scene) */
function translateScene(content: string): string {
    // 1. Translate node types first (Entity2D → Node2D, etc.)
    let result = translateNodeTypes(content);

    // 2. Collect all ExtResource("path") references and assign IDs
    const extResources: Array<{ id: string; path: string; type: string }> = [];
    const pathToId = new Map<string, string>();
    let idCounter = 1;

    const extResRegex = /ExtResource\("([^"]+)"\)/g;
    let match: RegExpExecArray | null;
    const seenPaths = new Set<string>();

    // First pass: find all unique ExtResource paths
    while ((match = extResRegex.exec(result)) !== null) {
        const rawPath = match[1];
        if (!seenPaths.has(rawPath)) {
            seenPaths.add(rawPath);
            const id = String(idCounter++);
            const godotPath = translatePath(rawPath);
            const type = inferResourceType(godotPath);
            extResources.push({ id, path: godotPath, type });
            pathToId.set(rawPath, id);
        }
    }

    // 3. Replace header — preserve uid if present
    result = result.replace(
        /\[axiom_scene([^\]]*)\]/,
        (_m, attrs) => {
            const loadSteps = extResources.length > 0 ? ` load_steps=${extResources.length + 1}` : '';
            // Preserve existing attributes (format, uid, etc.)
            let cleanAttrs = (attrs as string).trim();
            // Ensure format=3 exists
            if (!cleanAttrs.includes('format=')) {
                cleanAttrs = cleanAttrs ? `${cleanAttrs} format=3` : 'format=3';
            }
            return `[gd_scene${loadSteps} ${cleanAttrs}]`;
        },
    );

    // 4. Replace [axiom_resource ...] if present
    result = result.replace(/\[axiom_resource/g, '[gd_resource');

    // 5. Insert [ext_resource] declarations after the header line
    if (extResources.length > 0) {
        const declarations = extResources
            .map((r) => `[ext_resource type="${r.type}" path="res://${r.path}" id="${r.id}"]`)
            .join('\n');

        // Insert after the first line ([gd_scene ...])
        const headerEnd = result.indexOf('\n');
        if (headerEnd !== -1) {
            result = result.slice(0, headerEnd + 1) + '\n' + declarations + '\n' + result.slice(headerEnd + 1);
        }
    }

    // 6. Replace ExtResource("path") with ExtResource("id")
    for (const [rawPath, id] of pathToId) {
        result = result.replaceAll(`ExtResource("${rawPath}")`, `ExtResource("${id}")`);
    }

    // 7. Translate any remaining path references inside the scene
    result = result.replace(/\.axs"/g, '.gd"');
    result = result.replace(/\.scene"/g, '.tscn"');

    return result;
}

/** Infer Godot resource type from file extension */
function inferResourceType(path: string): string {
    if (path.endsWith('.gd')) return 'Script';
    if (path.endsWith('.tscn')) return 'PackedScene';
    if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.svg')) return 'Texture2D';
    if (path.endsWith('.tres') || path.endsWith('.res')) return 'Resource';
    if (path.endsWith('.glb') || path.endsWith('.gltf')) return 'PackedScene';
    if (path.endsWith('.ogg') || path.endsWith('.wav') || path.endsWith('.mp3')) return 'AudioStream';
    return 'Resource';
}

// ── Reverse Translation (Engine → UI) ─────────────────────────────

const REVERSE_EXT_MAP: Array<[RegExp, string]> = [
    [/\.tscn/g, '.scene'],
    [/\.gd/g, '.axs'],
    [/project\.godot/g, 'project.axiom'],
];

const REVERSE_NODE_MAP: Array<[RegExp, string]> = [
    [/\bNode2D\b/g, 'Entity2D'],
    [/\bNode3D\b/g, 'Entity3D'],
];

/**
 * Translate a Godot engine message back to Axiom branding.
 * Used for console output so the user never sees .gd / .tscn / project.godot.
 */
export function translateEngineMessage(message: string): string {
    let result = message;
    for (const [re, replacement] of REVERSE_EXT_MAP) {
        result = result.replace(re, replacement);
    }
    for (const [re, replacement] of REVERSE_NODE_MAP) {
        result = result.replace(re, replacement);
    }
    return result;
}

// ── Batch Translation ─────────────────────────────────────────────

export interface ProjectFile {
    path: string;
    content: string;
    /** 'base64' for binary files (PNG, audio, glb). Defaults to 'utf8'.
     *  Binary content is passed through verbatim — only the path is translated. */
    encoding?: 'utf8' | 'base64';
}

/**
 * Translate an entire set of project files from Axiom format to Godot native.
 * This is the main entry point — call it right before sending files to the engine.
 *
 * Also injects the AxiomInspector autoload script so the React bridge can talk
 * to the live SceneTree. The script is idempotent: re-injecting on every
 * sync-files call is safe.
 */
export function translateProjectFiles(axiomFiles: ProjectFile[]): ProjectFile[] {
    const translated: ProjectFile[] = axiomFiles.map((file) => {
        if (file.encoding === 'base64') {
            // Binary: path can still be translated (e.g. .scene → .tscn inside
            // zipped assets someday), but content is opaque — leave it alone.
            return { path: translatePath(file.path), content: file.content, encoding: 'base64' };
        }
        return {
            path: translatePath(file.path),
            content: translateContent(file.path, file.content),
            encoding: file.encoding,
        };
    });

    // Make sure the inspector script is in the project. We always overwrite
    // so changes to runtime/axiom_inspector.ts pick up on the next sync.
    const inspectorIdx = translated.findIndex((f) => f.path === AXIOM_INSPECTOR_PATH);
    const inspectorFile: ProjectFile = {
        path: AXIOM_INSPECTOR_PATH,
        content: AXIOM_INSPECTOR_GD,
        encoding: 'utf8',
    };
    if (inspectorIdx >= 0) {
        translated[inspectorIdx] = inspectorFile;
    } else {
        translated.push(inspectorFile);
    }

    return translated;
}
