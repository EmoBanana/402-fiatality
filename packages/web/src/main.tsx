// Hanken Grotesk for every word you read; DSEG7 only for the brand's 4:02 display, like a digital clock.
import "@fontsource-variable/hanken-grotesk";
import "@fontsource/dseg7/classic-700.css";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { initTheme } from "./lib/theme";
import { router } from "./router";

initTheme();

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
