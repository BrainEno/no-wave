import Link from "next/link";

export default function NotFound() {
  return <main style={{ maxWidth: 760, margin: "4rem auto", padding: "0 1.25rem" }}><h1>Not found</h1><p>The requested public resource does not exist.</p><Link href="/">Return home</Link></main>;
}
