import React from "react";
import ReactDOM from "react-dom/client";
// Base styles first, so each section's own CSS can override them
import "./styles/base.css";
import "./styles/shell.css";
import App from "./App";
import { startMcp } from "./mcp/bridge";
import { watchScrollbars } from "./lib/scrollbars";

// Only macOS puts the window's buttons over the sidebar; Windows and Linux
// give the window a title bar of their own
document.documentElement.dataset.os = /Mac/.test(navigator.userAgent) ? "mac" : "other";

// AI agents' calls run here, whichever section is open
startMcp();
watchScrollbars();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
