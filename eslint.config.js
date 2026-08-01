import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default defineConfig(
  { ignores: ["dist/", "node_modules/", "coverage/"] },

  js.configs.recommended,
  tseslint.configs.recommended,

  // Everything outside the browser bundle runs on Bun or the Workers runtime,
  // both of which give us the Node-shaped globals (process, console, ...).
  // src/shared is on this side because the server imports it too; anything it
  // uses has to exist in both runtimes regardless of what lint allows.
  {
    ignores: ["src/web/**"],
    languageOptions: { globals: globals.node },
  },

  // The web bundle is the only code that touches the DOM.
  {
    files: ["src/web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
);
