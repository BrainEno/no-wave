// typescript-eslint reads types through the TypeScript *JavaScript* compiler API.
// The project compiles with TypeScript 7 (the native port), whose 7.0 package
// does not ship that API, and typescript-eslint 8 supports TypeScript < 6.1.
// This package exists so pnpm resolves typescript-eslint's `typescript` peer to
// 6.0 here, while every build, typecheck and editor keeps using 7. Remove it
// once typescript-eslint supports the TypeScript the repository pins.
import ts from "typescript";

export { default } from "typescript-eslint";
export const typescriptVersion = ts.version;
