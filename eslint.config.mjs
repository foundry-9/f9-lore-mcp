import { defineConfig, globalIgnores } from "eslint/config";
import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
  globalIgnores(["main.js", "node_modules/**"]),
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },

    // You can add your own configuration to override or add rules
    rules: {
      // Turn off sample-names rule (not applicable to this project)
      "obsidianmd/sample-names": "off",
      // Configure sentence case with our custom acronyms and brands
      "obsidianmd/ui/sentence-case": ["error", {
        acronyms: ["MCP", "SSE", "TF-IDF", "IDF"],
        brands: ["Ollama", "OpenAI", "Claude", "Claude Desktop", "Lore MCP", "Azure OpenAI", "Host"],
        allowAutoFix: true,
      }],
      // Disable strict TypeScript rules that conflict with Obsidian's untyped APIs
      // (plugin.loadData() returns any, JSON.parse() returns any)
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
]);
