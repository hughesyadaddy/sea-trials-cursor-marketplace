/**
 * Explicit lib → test covering map (non-conventional names allowed).
 *
 * Env: ST_AGENT_VALIDATE_COVERS=
 *   flutter/packages/foo/lib/a.dart=flutter/packages/foo/test/custom_test.dart
 *   (; or newline separated pairs)
 */

/**
 * @param {string} [raw]
 * @returns {Map<string, string[]>} repo-relative lib path → repo-relative test paths
 */
export function parseExplicitCoveringMap(raw) {
  /** @type {Map<string, string[]>} */
  const map = new Map();
  const text = (raw ?? '').trim();
  if (!text) return map;
  const parts = text.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const lib = part.slice(0, eq).trim().replace(/\\/g, '/');
    const test = part.slice(eq + 1).trim().replace(/\\/g, '/');
    if (!lib || !test) continue;
    if (!map.has(lib)) map.set(lib, []);
    const list = map.get(lib);
    if (!list.includes(test)) list.push(test);
  }
  return map;
}
