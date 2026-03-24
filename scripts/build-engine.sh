#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Axiom Engine — Web (WASM) Build Script
# Compiles the Axiom engine fork to WebAssembly using Emscripten + SCons
# Output: public/engine/axiom.js, axiom.wasm, audio worklets
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENGINE_DIR="$PROJECT_ROOT/engine"
OUTPUT_DIR="$PROJECT_ROOT/public/engine"
EMSDK_DIR="$PROJECT_ROOT/.emsdk"
MIN_EMSCRIPTEN="3.1.62"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[axiom]${NC} $1"; }
ok()    { echo -e "${GREEN}[  ok ]${NC} $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $1"; }
fail()  { echo -e "${RED}[fail]${NC} $1"; exit 1; }

# ── Check-only mode ─────────────────────────────────────────────────────────
if [[ "${1:-}" == "--check" ]]; then
    echo "Checking build dependencies..."
    MISSING=0
    command -v python3 >/dev/null 2>&1 && ok "Python3 found" || { warn "Python3 not found"; MISSING=1; }
    command -v scons   >/dev/null 2>&1 && ok "SCons found"   || { warn "SCons not found (pip install scons)"; MISSING=1; }
    command -v emcc    >/dev/null 2>&1 && ok "Emscripten found" || { warn "Emscripten not found"; MISSING=1; }
    [[ -d "$ENGINE_DIR" ]] && ok "Engine directory found" || { warn "Engine directory not found at $ENGINE_DIR"; MISSING=1; }
    [[ $MISSING -eq 0 ]] && ok "All dependencies satisfied" || warn "Some dependencies are missing"
    exit $MISSING
fi

# ── Step 1: Check Python ────────────────────────────────────────────────────
info "Checking Python..."
command -v python3 >/dev/null 2>&1 || fail "Python 3.8+ is required. Install it from https://python.org"
PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
ok "Python $PYTHON_VERSION"

# ── Step 2: Check/Install SCons ─────────────────────────────────────────────
info "Checking SCons..."
if ! command -v scons >/dev/null 2>&1; then
    warn "SCons not found. Installing via pip..."
    python3 -m pip install --user scons || fail "Failed to install SCons"
fi
ok "SCons $(scons --version 2>/dev/null | head -1 || echo 'installed')"

# ── Step 3: Check/Install Emscripten ────────────────────────────────────────
info "Checking Emscripten..."
if ! command -v emcc >/dev/null 2>&1; then
    warn "Emscripten not found. Installing emsdk..."

    if [[ ! -d "$EMSDK_DIR" ]]; then
        git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
    fi

    cd "$EMSDK_DIR"
    ./emsdk install "$MIN_EMSCRIPTEN"
    ./emsdk activate "$MIN_EMSCRIPTEN"
    source "$EMSDK_DIR/emsdk_env.sh"
    cd "$PROJECT_ROOT"
fi

# Verify version
EMCC_VERSION=$(emcc --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
ok "Emscripten $EMCC_VERSION"

# ── Step 4: Verify engine directory ─────────────────────────────────────────
[[ -d "$ENGINE_DIR" ]] || fail "Engine directory not found at $ENGINE_DIR"
[[ -f "$ENGINE_DIR/SConstruct" ]] || fail "SConstruct not found in engine directory"
ok "Engine source found"

# ── Step 5: Compile engine for web ──────────────────────────────────────────
info "Compiling Axiom Engine for Web (WASM)..."
info "This may take 30-60 minutes on the first build."
echo ""

BUILD_TARGET="${BUILD_TARGET:-template_debug}"
NUM_JOBS="${NUM_JOBS:-$(( $(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4) ))}"

cd "$ENGINE_DIR"
scons \
    platform=web \
    target="$BUILD_TARGET" \
    optimize=size \
    -j"$NUM_JOBS" \
    || fail "Engine compilation failed"

ok "Engine compiled successfully"

# ── Step 6: Copy output files ───────────────────────────────────────────────
info "Copying build artifacts to $OUTPUT_DIR..."
mkdir -p "$OUTPUT_DIR"

# The build produces files in engine/bin/
BIN_DIR="$ENGINE_DIR/bin"

# Find the compiled files
WASM_FILE=$(find "$BIN_DIR" -name "*.wasm" -not -name "*.side.wasm" | head -1)
JS_FILE=$(find "$BIN_DIR" -name "axiom.*.js" -not -name "*.worker.js" -not -name "*.worklet.js" | head -1)

if [[ -z "$WASM_FILE" || -z "$JS_FILE" ]]; then
    # Try the zip approach — the build may create a zip
    ZIP_FILE=$(find "$BIN_DIR" -name "axiom*.zip" | head -1)
    if [[ -n "$ZIP_FILE" ]]; then
        info "Extracting from build zip..."
        unzip -o "$ZIP_FILE" -d "$OUTPUT_DIR/"
        ok "Extracted build artifacts from zip"
    else
        fail "Could not find compiled .wasm and .js files in $BIN_DIR"
    fi
else
    cp "$WASM_FILE" "$OUTPUT_DIR/axiom.wasm"
    cp "$JS_FILE" "$OUTPUT_DIR/axiom.js"
    ok "Copied axiom.wasm ($(du -h "$WASM_FILE" | cut -f1))"
    ok "Copied axiom.js ($(du -h "$JS_FILE" | cut -f1))"
fi

# Copy audio worklets if they exist
for worklet in "$BIN_DIR"/*.worklet.js "$ENGINE_DIR/platform/web/js/libs/"*.worklet.js; do
    if [[ -f "$worklet" ]]; then
        cp "$worklet" "$OUTPUT_DIR/"
        ok "Copied $(basename "$worklet")"
    fi
done

# ── Step 7: Summary ────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN} Axiom Engine WASM build complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Output directory: $OUTPUT_DIR"
echo "  Files:"
ls -lh "$OUTPUT_DIR/" 2>/dev/null | tail -n +2 | awk '{print "    " $NF " (" $5 ")"}'
echo ""
echo "  Run 'npm run dev' and open the editor to test."
echo ""
