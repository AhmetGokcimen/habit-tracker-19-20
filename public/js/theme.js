// Applies the colour theme the user picked (light / dark) before the page is
// painted, so there is no flash of the wrong theme. A classic (non-module)
// script from this origin, so the strict CSP allows it. Without a saved
// choice the CSS follows the system setting (prefers-color-scheme).
(function () {
  try {
    var theme = localStorage.getItem('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    // storage blocked: follow the system setting
  }
})();
