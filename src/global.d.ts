// Ambient type references for the whole program.
// `chrome` global namespace from @types/chrome — referenced explicitly here so
// the MV3 service worker / extension code typechecks under `tsc --noEmit`.
// (pnpm's non-hoisted layout otherwise leaves @types/chrome's transitive
// references unresolved, dropping the global and producing ~450 phantom errors.)
/// <reference types="chrome" />
