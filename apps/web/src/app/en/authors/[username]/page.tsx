import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuthorProfileContent } from "@/components/content-pages";
import { authorMetadata } from "@/lib/content.ts";
import { getPublicAuthor } from "@/lib/api-content.ts";

type PageProps = { params: Promise<{ username: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { username } = await params;
  const author = await getPublicAuthor(username, "en");
  if (!author) return {};
  return authorMetadata(author, process.env.NEXT_PUBLIC_SITE_URL ?? "https://example.invalid") as Metadata;
}

export default async function EnglishAuthorPage({ params }: PageProps) {
  const { username } = await params;
  const author = await getPublicAuthor(username, "en");
  if (!author) notFound();
  return <AuthorProfileContent locale="en" author={author} />;
}
