import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default async function AccountPage() {
  // Deny by default until a real server-side session verifier is implemented.
  // Never use a client-controlled header as proof of identity.
  redirect("/sign-in?next=%2Faccount");
}
