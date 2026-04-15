(function themeInit() {
  document.documentElement.setAttribute('data-theme', 'dark');
  window.HomeBaseTheme = {
    get() { return 'dark'; },
  };
}());
