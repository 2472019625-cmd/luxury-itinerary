import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { DemoSession } from "./DemoSession.jsx";
import "./styles.css";
import "./workspace.css";
import "./agent-planner.css";
import webFontsUrl from "./web-fonts.css?url";
import exportFontsUrl from "./export-fonts.css?url";

// Export keeps the original font files and loading behavior. Do not inject both
// stylesheets: that would make browser previews download the originals too.
const fonts = document.createElement("link");
fonts.rel = "stylesheet";
fonts.href = new URLSearchParams(window.location.search).get("export") === "1"
  ? exportFontsUrl : webFontsUrl;
fonts.onload = mount;
fonts.onerror = () => { console.error("Font stylesheet could not be loaded"); mount(); };
document.head.appendChild(fonts);

function mount() {
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DemoSession><App /></DemoSession>
  </React.StrictMode>,
);
}
