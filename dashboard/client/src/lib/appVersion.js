/* global __APP_VERSION__ */
// Injected at build time by vite.config.js from dashboard/VERSION.
// "dev" only appears when the file is evaluated outside a Vite build.
export const APP_VERSION =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
