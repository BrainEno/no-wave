import parser from "@babel/eslint-parser";
import hooks from "eslint-plugin-react-hooks";
import a11y from "eslint-plugin-jsx-a11y";

// JSX exists only in .tsx, as in TypeScript itself: parsing .ts with the jsx
// plugin makes a generic arrow such as `<T>(x: T) => x` read as an open tag
// (Babel 8 no longer guesses its way out of that ambiguity).
const languageOptions = (plugins: string[]) => ({
  parser,
  parserOptions: {
    requireConfigFile: false,
    babelOptions: { parserOpts: { plugins } },
    sourceType: "module",
  },
});

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
    languageOptions: languageOptions(["typescript"]),
    plugins: { "react-hooks": hooks, "jsx-a11y": a11y },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "jsx-a11y/alt-text": "error",
    },
  },
  {
    files: ["**/*.tsx"],
    languageOptions: languageOptions(["typescript", "jsx"]),
  },
];
