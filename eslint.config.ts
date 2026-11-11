import parser from "@typescript-eslint/parser";
import hooks from "eslint-plugin-react-hooks";
import a11y from "eslint-plugin-jsx-a11y";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/build/**",
      "**/dist/**",
      "**/.react-router/**",
      "**/coverage/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
    },
    plugins: { "react-hooks": hooks, "jsx-a11y": a11y },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "jsx-a11y/alt-text": "error",
    },
  },
];
