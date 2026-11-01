/**
 * The hooks the shared UI uses to navigate — see `./link.tsx` for why they
 * live behind this module rather than behind `next/navigation`.
 *
 * Only what is actually used is exported. A seam that offers the whole surface
 * of a framework is not a seam, it is a deferral.
 */
export { usePathname, useRouter } from "next/navigation";
