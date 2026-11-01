/**
 * Navigation, as the shared UI needs it — not as one framework spells it.
 *
 * Everything under `apps/web/src/components` is rendered by two applications:
 * the Next.js App Router and the React Router prototype. A component that
 * imports `next/link` is a component that has decided which of them is real,
 * and the only thing that made it work in the other one was a build alias
 * quietly rewriting the specifier. This module is the seam made explicit: the
 * component asks for a `Link`, and each application supplies its own.
 *
 * Deleting Next.js later is then a matter of replacing the two files in this
 * directory — not of touching twenty-one components, and not of inventing an
 * adapter for an import that should never have been named after a framework.
 *
 * The `Link` is a named export in both implementations on purpose: Next.js
 * exports it as a default, React Router as a named one, and the difference
 * should be settled here rather than at every call site.
 */
export { default as Link } from "next/link";
