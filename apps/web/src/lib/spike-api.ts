export async function submitDraftToMockApi(title) {
  if (title === "simulate-server-error") {
    return { ok: false, status: 503, message: "The demo API is temporarily unavailable." };
  }

  return { ok: true, status: 201, message: "Mock API accepted the draft." };
}
