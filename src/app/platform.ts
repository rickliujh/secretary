/** Where the webview runs; decides the window chrome (D36). */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
/** macOS keeps its traffic lights, drawn over the app header; elsewhere the app draws buttons. */
export const macOverlay = inTauri && isMac;
export const ownWindowButtons = inTauri && !isMac;
