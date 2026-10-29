import type { Metadata } from "next";
import { AuthoringWorkspace } from "@/components/authoring/authoring-workspace.tsx";

export const metadata: Metadata = {
  title: "写作台",
  robots: { index: false, follow: false },
};

export default function WritePage() {
  return <main className="nw-w nw-head"><AuthoringWorkspace /></main>;
}
