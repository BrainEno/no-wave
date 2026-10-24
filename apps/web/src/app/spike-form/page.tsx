import { SpikeForm } from "./form";

export const metadata = { title: "Form behavior spike", robots: { index: false, follow: false } };

export default function SpikeFormPage() {
  return (
    <main style={{ maxWidth: 600, margin: "4rem auto", padding: "0 1.25rem" }}>
      <h1>Form behavior spike</h1>
      <p>Checks validation and a mocked API failure state; it does not write production data.</p>
      <p>To preview the deterministic failure state, submit the title <code>simulate-server-error</code>.</p>
      <SpikeForm />
    </main>
  );
}
