# Agent Learnings

## Web UI: iOS Input Auto-Zoom Guard

- iOS Safari/WKWebView auto-zooms focused text-entry controls when their computed font-size is below 16px; keep login/admin `input`, `select`, and `textarea` controls at `font-size: 1rem` minimum
- Set the control font-size explicitly rather than relying on browser defaults or inherited body sizing so auth forms stay stable if typography tokens shift later
