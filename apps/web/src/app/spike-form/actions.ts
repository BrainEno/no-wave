"use server";

import { submitDraftToMockApi } from "@/lib/spike-api.mjs";

export type FormState = { message: string; fieldError?: string };

export async function submitSpikeForm(_previousState: FormState, formData: FormData): Promise<FormState> {
  const title = formData.get("title");
  if (typeof title !== "string" || title.trim().length < 3) {
    return { message: "Please correct the form.", fieldError: "Title must be at least 3 characters." };
  }

  // This in-process adapter simulates an API contract; it is not the production API.
  const response = await submitDraftToMockApi(title.trim());
  if (!response.ok) {
    return { message: response.message };
  }
  return { message: response.message };
}
