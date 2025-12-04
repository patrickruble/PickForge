import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { inject } from "@vercel/analytics";

// Enable Vercel Analytics
inject();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// if (process.env.NODE_ENV !== "production") {
//   import("@axe-core/react").then(({ default: axe }) => {
//     const React = require("react");
//     const ReactDOM = require("react-dom");
//     axe(React, ReactDOM, 1000);
//   });
// }