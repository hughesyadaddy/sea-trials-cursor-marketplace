/* Fold / expand, natural order, press-hold drag helpers */
window.SprintTreeUI = (function () {
  const LS_KEY = "sprint-viewer-fold-v1";
  const HOLD_MS = 350;
  const MOVE_PX = 6;

  function loadFold() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
  }
  function saveFold(state) {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }

  function naturalKey(s) {
    return String(s || "").split(/(\d+)/).map(p => (/^\d+$/.test(p) ? Number(p) : p.toLowerCase()));
  }

  function sortSiblings(arr) {
    return (arr || []).slice().sort((a, b) => {
      const ao = a.order != null ? a.order : 9999;
      const bo = b.order != null ? b.order : 9999;
      if (ao !== bo) return ao - bo;
      const ka = naturalKey(a.plan_number || a.key || "");
      const kb = naturalKey(b.plan_number || b.key || "");
      for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
        if (ka[i] === kb[i]) continue;
        if (ka[i] == null) return -1;
        if (kb[i] == null) return 1;
        if (typeof ka[i] === "number" && typeof kb[i] === "number") return ka[i] - kb[i];
        return String(ka[i]).localeCompare(String(kb[i]));
      }
      return 0;
    });
  }

  /** Pure helper: after hold ms with movement <= movePx → arm; else click. */
  function classifyPointerGesture(opts) {
    const holdMs = opts.holdMs != null ? opts.holdMs : HOLD_MS;
    const movePx = opts.movePx != null ? opts.movePx : MOVE_PX;
    const dt = opts.durationMs;
    const dist = Math.hypot(opts.dx || 0, opts.dy || 0);
    if (dist > movePx && dt < holdMs) return "cancel-then-click"; // moved early → treat release as click only if short
    if (dt >= holdMs && dist <= movePx) return "arm-drag";
    if (dt < holdMs) return "click";
    // held long but moved a lot after arming is handled by drag state machine
    return "drag";
  }

  function shouldArmHold(elapsedMs, dx, dy, holdMs, movePx) {
    holdMs = holdMs != null ? holdMs : HOLD_MS;
    movePx = movePx != null ? movePx : MOVE_PX;
    return elapsedMs >= holdMs && Math.hypot(dx || 0, dy || 0) <= movePx;
  }

  function shouldCancelHold(dx, dy, movePx) {
    movePx = movePx != null ? movePx : MOVE_PX;
    return Math.hypot(dx || 0, dy || 0) > movePx;
  }

  /** Compute insert index among sibling row rects for a pointer Y. Returns 0..n. */
  function dropIndexFromY(clientY, siblingRects) {
    // siblingRects: [{id, top, bottom, mid}] in current visual order
    if (!siblingRects || !siblingRects.length) return 0;
    for (let i = 0; i < siblingRects.length; i++) {
      if (clientY < siblingRects[i].mid) return i;
    }
    return siblingRects.length;
  }

  /** Apply reorder: move fromIndex into insertIndex (before that slot; insertIndex may be length). */
  function reorderArray(arr, fromIndex, insertIndex) {
    const a = arr.slice();
    if (fromIndex < 0 || fromIndex >= a.length) return a;
    const [item] = a.splice(fromIndex, 1);
    let to = insertIndex;
    if (fromIndex < insertIndex) to = insertIndex - 1;
    if (to < 0) to = 0;
    if (to > a.length) to = a.length;
    a.splice(to, 0, item);
    return a;
  }

  return {
    loadFold, saveFold, naturalKey, sortSiblings, LS_KEY,
    HOLD_MS, MOVE_PX, classifyPointerGesture, shouldArmHold, shouldCancelHold,
    dropIndexFromY, reorderArray,
  };
})();
