/** Theme mode — light / dark / system(auto). Owned by App.tsx state; the
 *  segmented control in the Settings root page reads and writes it. Migrated
 *  out of the removed TopBarThemeButton so the type outlives that component. */
export type ThemeMode = "light" | "dark" | "system";
