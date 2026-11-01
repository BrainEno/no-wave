/**
 * The form-behaviour spike, as a screen.
 *
 * A plain `<form method="post">`: what happens to the submission is the routing
 * framework's business, and this component says nothing about it. The pending
 * state arrives as a prop for the same reason — the app knows when it is
 * navigating, and a component that imported a router to find out would stop
 * being reusable.
 *
 * It exists to make one thing observable by hand: a validation error and a
 * mocked API failure, both of which have to reach the screen without a reload
 * losing them. Nothing here writes production data.
 */
export function SpikeFormPanel({ fieldError, message, pending = false }: {
  fieldError?: string;
  message?: string;
  pending?: boolean;
}) {
  return (
    <>
      <h1>Form behavior spike</h1>
      <p>Checks validation and a mocked API failure state; it does not write production data.</p>
      <p>To preview the deterministic failure state, submit the title <code>simulate-server-error</code>.</p>
      <form method="post">
        <label htmlFor="title">Title</label>
        <input id="title" name="title" minLength={3} required />
        <button type="submit" disabled={pending}>{pending ? "Checking…" : "Validate"}</button>
        {fieldError ? <p role="alert">{fieldError}</p> : null}
        {message ? <p role="status">{message}</p> : null}
      </form>
    </>
  );
}
