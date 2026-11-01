/**
 * Vite resolves `*.module.css` to a map of class names; TypeScript does not know
 * that, because the transformation happens in the bundler rather than in a type
 * declaration a compiler can read. Next.js shipped an equivalent declaration in
 * `next-env.d.ts` — with it gone, the package states it for itself.
 */
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
