"use client";

import { FormEvent, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";

type Citation = {
  chunkId: string;
  documentId: string;
  title: string;
  section?: string | null;
  sourceUrl?: string | null;
};
type Answer = {
  status: "answered" | "insufficient_evidence";
  answer: string;
  citations: Citation[];
  queryId?: string;
};

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export function Chat() {
  const [message, setMessage] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = message.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token)
        throw new Error("Debes iniciar sesión antes de consultar la base de conocimiento.");
      const endpoint = process.env.NEXT_PUBLIC_CHAT_FUNCTION_URL;
      if (!endpoint) throw new Error("Falta configurar NEXT_PUBLIC_CHAT_FUNCTION_URL.");
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: clean }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload?.error?.message ?? "No fue posible obtener una respuesta.");
      setAnswer(payload as Answer);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="chatCard">
      {answer && (
        <article className="answer">
          <p>{answer.answer}</p>
          {answer.citations.length > 0 && (
            <div className="sources">
              <strong>Fuentes</strong>
              <ul>
                {answer.citations.map((c) => (
                  <li key={c.chunkId}>
                    {c.sourceUrl ? (
                      <a href={c.sourceUrl} target="_blank" rel="noreferrer">
                        {c.title}
                        {c.section ? ` — ${c.section}` : ""}
                      </a>
                    ) : (
                      `${c.title}${c.section ? ` — ${c.section}` : ""}`
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </article>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={submit} className="composer">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Escribe tu pregunta…"
          rows={3}
          maxLength={4000}
        />
        <button disabled={busy || !message.trim()}>{busy ? "Consultando…" : "Preguntar"}</button>
      </form>
    </section>
  );
}
