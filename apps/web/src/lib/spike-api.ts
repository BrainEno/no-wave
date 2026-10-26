export type MockApiResponse =
  | { ok: true; status: 201; message: string }
  | { ok: false; status: 503; message: string };

export async function submitDraftToMockApi(title: string): Promise<MockApiResponse> {
  if (title === "simulate-server-error") {
    return { ok: false, status: 503, message: "The demo API is temporarily unavailable." };
  }

  return { ok: true, status: 201, message: "Mock API accepted the draft." };
}
