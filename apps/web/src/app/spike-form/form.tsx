"use client";

import { useActionState } from "react";
import { submitSpikeForm, type FormState } from "./actions";

const initialState: FormState = { message: "" };

export function SpikeForm() {
  const [state, action, pending] = useActionState(submitSpikeForm, initialState);
  return <form action={action}><label htmlFor="title">Title</label><input id="title" name="title" minLength={3} required /><button type="submit" disabled={pending}>{pending ? "Checking…" : "Validate"}</button>{state.fieldError ? <p role="alert">{state.fieldError}</p> : null}{state.message ? <p role="status">{state.message}</p> : null}</form>;
}
