import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuthorProfileContent } from "@/components/content-pages";
import { parsePage, parseWorkType } from "@/lib/work-types.ts";
import { authorMetadata } from "@/lib/content.ts";
import { configuredSiteUrl } from "@/lib/site-metadata.ts";
import { getPublicAuthor } from "@/lib/api-content.ts";

type PageProps = { params: Promise<{ username: string }>; searchParams: Promise<{ page?: string | string[]; type?: string | string[] }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { username } = await params;
  const author = await getPublicAuthor(username, "en");
  // 在流式外壳发出前抛出 notFound()，保证未知作者返回 404 状态码（而非软 404）。
  if (!author) notFound();
  return authorMetadata(author, configuredSiteUrl()) as Metadata;
}

export default async function EnglishAuthorPage({ params, searchParams }: PageProps) {
  const [{ username }, query] = await Promise.all([params, searchParams]);
  const author = await getPublicAuthor(username, "en");
  if (!author) notFound();
  return <AuthorProfileContent locale="en" author={author} type={parseWorkType(query.type)} page={parsePage(query.page)} />;
}
