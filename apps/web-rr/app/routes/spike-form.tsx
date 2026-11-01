import { useActionData, useNavigation } from "react-router";
import type { ActionFunctionArgs, HeadersFunction, MetaFunction } from "react-router";
import { SpikeFormPanel } from "@/components/spike/spike-form-panel.tsx";
import { PUBLIC_PAGE_HEADERS } from "../lib/http-policy.ts";
import { metaDescriptors } from "../lib/meta.ts";

/**
 * `/spike-form` — the form-behaviour spike, ported from a Next.js Server Action.
 *
 * The validation and the mocked call were never the point of the Server Action;
 * the point was that they ran on the server and their answer reached the screen.
 * A route action is the same thing here, so the component is unchanged and the
 * behaviour is preserved: too short a title comes back as a field error, and
 * `simulate-server-error` comes back as the failure state.
 */
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const title = form.get("title");
  if (typeof title !== "string" || title.trim().length < 3) {
    return { message: "Please correct the form.", fieldError: "Title must be at least 3 characters." };
  }
  const { submitDraftToMockApi } = await import("@/lib/spike-api.ts");
  const response = await submitDraftToMockApi(title.trim());
  return { message: response.message };
}

export const headers: HeadersFunction = () => PUBLIC_PAGE_HEADERS;

/**
 * Unindexed: a spike has no business being found. `metaDescriptors` carries the
 * shared
 * metadata shape, which has no `robots` field, so the tag is appended.
 */
export const meta: MetaFunction = () => [
  ...metaDescriptors({ title: "Form behavior spike" }),
  { name: "robots", content: "noindex, nofollow" },
];

export default function SpikeFormRoute() {
  const result = useActionData<typeof action>();
  const pending = useNavigation().state !== "idle";
  return (
    <main style={{ maxWidth: 600, margin: "4rem auto", padding: "0 1.25rem" }} data-route="spike-form">
      <SpikeFormPanel pending={pending} {...(result ?? {})} />
    </main>
  );
}
