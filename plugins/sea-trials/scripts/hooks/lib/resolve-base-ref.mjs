/**
 * Resolve the git base ref that pre-push checks should diff against.
 *
 * TWO MODES:
 *
 * Incremental (`preferUpstreamIncremental: true`, the pre-push
 * default since 2026-07-08): diff against the branch's OWN upstream
 * merge-base, i.e. validate only the commits actually being pushed.
 * On long-lived branches the full-branch diff can reach 700+ files
 * across dozens of packages, turning every push into a 20-minute
 * machine-wide analyze storm — while CI re-runs the exact same gates
 * on the full branch anyway, so nothing escapes review; drift in
 * previously-pushed commits just fails in CI instead of locally.
 * Set `PREPUSH_FULL_BRANCH=1` to force CI-parity full-branch checks
 * before merging.
 *
 * Full-branch (default when `preferUpstreamIncremental` is false, or
 * when the branch has no upstream — e.g. its first push): matches CI
 * (`.github/workflows/pr-checks.yml`), which always diffs the ENTIRE
 * branch against the PR base (`origin/${base_ref}`):
 *
 *   BASE=$(git merge-base "origin/${base_ref}" HEAD)
 *   git diff --name-only "$BASE"..HEAD
 *
 * Full-branch preference order:
 *   1. merge-base(HEAD, configured PR base)   ← matches CI base branch
 *   2. merge-base(HEAD, origin/main)          ← safe default
 *   3. merge-base(HEAD, main)                 ← local-only repos
 *   4. merge-base(HEAD, upstream)             ← non-main fallback
 *   5. HEAD~1                                 ← detached / shallow
 *
 * All git access is injected so this stays pure and unit-testable.
 *
 * @param {object} deps
 * @param {(a: string, b: string) => string|null} deps.getMergeBase
 * @param {() => string|null} deps.getUpstreamRef
 * @param {() => string[]|null} [deps.getPreferredBaseRefs]
 * @param {(ref: string) => string|null} deps.revParse
 * @param {boolean} [deps.preferUpstreamIncremental]
 * @returns {string} the base ref (commit sha or ref name)
 */
export function resolveBaseRef({
  getMergeBase,
  getUpstreamRef,
  getPreferredBaseRefs,
  revParse,
  preferUpstreamIncremental = false,
}) {
  if (preferUpstreamIncremental) {
    const upstream = getUpstreamRef();
    const fromUpstream = upstream ? getMergeBase('HEAD', upstream) : null;
    if (fromUpstream) return fromUpstream;
  }

  const preferredRefs = getPreferredBaseRefs?.() ?? [];
  for (const preferredRef of preferredRefs) {
    if (!preferredRef) continue;
    const fromPreferred = getMergeBase('HEAD', preferredRef);
    if (fromPreferred) return fromPreferred;
  }

  const fromOriginMain = getMergeBase('HEAD', 'origin/main');
  if (fromOriginMain) return fromOriginMain;

  const fromMain = getMergeBase('HEAD', 'main');
  if (fromMain) return fromMain;

  const upstream = getUpstreamRef();
  const fromUpstream = upstream ? getMergeBase('HEAD', upstream) : null;
  if (fromUpstream) return fromUpstream;

  return revParse('HEAD~1') || 'HEAD~1';
}
