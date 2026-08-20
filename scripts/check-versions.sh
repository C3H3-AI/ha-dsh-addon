#!/bin/bash
# ============================================================
# Version consistency check for ha-dsh-addon.
#
# IMPORTANT: the add-on and the companion custom_component are
# versioned on SEPARATE tracks BY DESIGN (see docs/DESIGN.md §1:
# "Addon 版本 0.2.15（配套集成 deepseek_harness 为 0.2.0）").
#
# We therefore verify INTERNAL consistency WITHIN each track,
# never across tracks:
#   addon track:       config.yaml == Dockerfile (ARG BUILD_VERSION)
#   integration track: const.py (VERSION) == manifest.json (version)
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
errors=0

echo "=== Version Consistency Check (dual-track) ==="
echo ""

# Extract versions from each source
CONST_PY_VERSION=$(grep -E '^VERSION\s*=' "$ROOT/custom_components/deepseek_harness/const.py" | sed -E 's/.*"([^"]+)".*/\1/')
MANIFEST_VERSION=$(grep -E '"version"' "$ROOT/custom_components/deepseek_harness/manifest.json" | sed -E 's/.*"([^"]+)".*/\1/')
CONFIG_YAML_VERSION=$(grep -E '^version:' "$ROOT/deepseek_harness/config.yaml" | sed -E 's/.*"([^"]+)".*/\1/')
DOCKERFILE_VERSION=$(grep -E '^ARG BUILD_VERSION=' "$ROOT/deepseek_harness/Dockerfile" | sed -E 's/.*"([^"]+)".*/\1/')

echo "  [addon track]"
echo "    config.yaml:  $CONFIG_YAML_VERSION"
echo "    Dockerfile:    $DOCKERFILE_VERSION"
echo "  [integration track]"
echo "    const.py:      $CONST_PY_VERSION"
echo "    manifest.json: $MANIFEST_VERSION"
echo ""

# ---- addon track: config.yaml == Dockerfile ----
if [ "$CONFIG_YAML_VERSION" != "$DOCKERFILE_VERSION" ]; then
    echo "  ✗ addon track mismatch: config.yaml ($CONFIG_YAML_VERSION) != Dockerfile ($DOCKERFILE_VERSION)"
    errors=$((errors + 1))
else
    echo "  ✓ addon track consistent: $CONFIG_YAML_VERSION"
fi

# ---- integration track: const.py == manifest.json ----
if [ "$CONST_PY_VERSION" != "$MANIFEST_VERSION" ]; then
    echo "  ✗ integration track mismatch: const.py ($CONST_PY_VERSION) != manifest.json ($MANIFEST_VERSION)"
    errors=$((errors + 1))
else
    echo "  ✓ integration track consistent: $CONST_PY_VERSION"
fi

echo ""
if [ "$errors" -eq 0 ]; then
    echo "  ✓ All version tracks consistent (addon: $CONFIG_YAML_VERSION, integration: $CONST_PY_VERSION)"
    exit 0
else
    echo "  ✗ $errors version track mismatch(es) found"
    exit 1
fi
