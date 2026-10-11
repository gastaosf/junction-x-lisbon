// Loaded as a plain script in <head>, before the style sheets paint anything: sets the theme the
// operator chose, so a light console (or a light stage on a projector) does not flash dark while
// the modules load. The server's CSP forbids inline scripts, hence this file. main.js applies the
// theme again and follows later changes; the keys are the ones prefs.js writes.
(function applyStoredTheme() {
  var root = document.documentElement;
  try {
    var onStage = /^\/runs\/[^/]+\/stage\/?$/.test(window.location.pathname);
    var stored = window.localStorage.getItem(onStage ? "astrolabio:stageTheme" : "astrolabio:theme");
    var theme = stored === null ? null : JSON.parse(stored);
    root.setAttribute("data-theme", theme === "light" ? "light" : "dark");
  } catch (_) {
    // No storage, or a value that is not JSON: index.html's default (dark) stays.
  }
})();
