import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default defineConfig(
  { ignores: ["dist/", "node_modules/", "coverage/", ".claude/"] },

  js.configs.recommended,
  tseslint.configs.recommended,

  // Everything outside the browser bundle and src/shared runs on Bun or the
  // Workers runtime, both of which give us the Node-shaped globals (process,
  // console, ...).
  {
    ignores: ["src/web/**", "src/shared/**"],
    languageOptions: { globals: globals.node },
  },

  // src/shared ships into all three runtimes, so it gets neither globals set:
  // the only host API it may name is the one types/shared-globals.d.ts grants.
  // The enforcement that matters is tsconfig.shared.json (no DOM, no Bun, no
  // Workers); this keeps lint's view of the file from disagreeing with it.
  {
    files: ["src/shared/**/*.ts"],
    languageOptions: { globals: {} },
  },

  // The web bundle is the only code that touches the DOM.
  {
    files: ["src/web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
);
