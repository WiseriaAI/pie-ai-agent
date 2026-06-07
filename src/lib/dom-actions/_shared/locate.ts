// CDP-evaluate-string locator. Shadow-aware (mirrors act-core findByIdxDeep);
// keeps subframe detection so callers distinguish in_subframe vs not_found.
// `${idx}` is substituted by the caller (buildReadEditorExpression etc.).
// Defines: const SEL, function _deep, const el, const win, function inSubframe,
// const _locatorReason. Callers reference `el` / `win` / `_locatorReason`.
export const LOCATE_BY_IDX_FRAGMENT = `
    const SEL = '[data-pie-idx="\${idx}"]';
    function _deep(root) {
      const d = root.querySelector(SEL);
      if (d) return d;
      const all = root.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const sr = all[i].shadowRoot;
        if (sr && sr.mode === 'open') { const f = _deep(sr); if (f) return f; }
      }
      return null;
    }
    const el = _deep(document);
    const win = window;
    function inSubframe(w) {
      const fs = w.frames;
      for (let i = 0; i < fs.length; i++) {
        try {
          if (_deep(fs[i].document)) return true;
          if (inSubframe(fs[i])) return true;
        } catch (e) {}
      }
      return false;
    }
    const _locatorReason = el ? null : (inSubframe(window) ? "in_subframe" : "not_found");
  `;
