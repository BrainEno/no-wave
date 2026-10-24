export type MockApiResponse =
  | { ok: true; status: 201; message: string }
  | { ok: false; status: 503; message: string };

export function submitDraftToMockApi(title: string): Promise<MockApiResponse>;
