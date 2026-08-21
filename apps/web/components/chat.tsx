"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

export type PublicCitation = {
  label?: string;
  title: string;
  section?: string;
  sourceUrl?: string;
};

export type ChatResponse = {
  answer: string;
  sources: PublicCitation[];
  citations: PublicCitation[];
  insufficient_evidence: boolean;
};

type TranscriptItem = {
  id: string;
  question: string;
  response: ChatResponse;
  feedback?: "useful" | "not_useful";
};

type AuthView = "loading" | "login" | "chat";

type ChatErrorKind = "auth" | "forbidden" | "server" | "network" | "malformed" | "config";

const GENERIC_ERRORS: Record<ChatErrorKind, string> = {
  auth: "Tu sesión expiró. Inicia sesión de nuevo para continuar.",
  forbidden: "No tienes acceso a esta base de conocimiento.",
  server: "No fue posible obtener una respuesta. Inténtalo de nuevo.",
  network: "No se pudo conectar con el servicio de chat. Revisa tu conexión.",
  malformed: "La respuesta del servicio no tuvo el formato esperado.",
  config: "Falta configuración pública del chat.",
};

export function getAuthView(authLoading: boolean, session: Session | null): AuthView {
  if (authLoading) return "loading";
  return session ? "chat" : "login";
}

export function createSupabaseBrowserClient(): SupabaseClient {
  const config = readPublicConfig();
  if (!config) throw new Error(GENERIC_ERRORS.config);
  return createBrowserClient(config.supabaseUrl, config.supabaseAnonKey);
}

export function buildChatRequest(token: string, message: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message }),
  };
}

export function validateChatResponse(value: unknown): ChatResponse {
  if (!isRecord(value)) throw new Error(GENERIC_ERRORS.malformed);

  const answer = typeof value.answer === "string" ? value.answer.trim() : "";
  if (!answer || typeof value.insufficient_evidence !== "boolean") {
    throw new Error(GENERIC_ERRORS.malformed);
  }

  const citations = sanitizeCitations(value.citations);
  const sources = sanitizeCitations(value.sources);

  if (value.insufficient_evidence) {
    return {
      answer,
      insufficient_evidence: true,
      citations: [],
      sources: [],
    };
  }

  return {
    answer,
    insufficient_evidence: false,
    citations,
    sources: sources.length > 0 ? sources : citations,
  };
}

export function publicSourcesFor(response: ChatResponse): PublicCitation[] {
  if (response.insufficient_evidence) return [];
  const preferred = response.citations.length > 0 ? response.citations : response.sources;
  const seen = new Set<string>();
  return preferred.filter((source) => {
    const key = `${source.label ?? ""}\n${source.title}\n${source.section ?? ""}\n${
      source.sourceUrl ?? ""
    }`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function safeChatError(status: number | null): string {
  if (status === 401) return GENERIC_ERRORS.auth;
  if (status === 403) return GENERIC_ERRORS.forbidden;
  if (status === null) return GENERIC_ERRORS.network;
  return GENERIC_ERRORS.server;
}

export function Chat() {
  const publicConfig = useMemo(() => readPublicConfig(), []);
  const supabase = useMemo(
    () =>
      publicConfig
        ? createBrowserClient(publicConfig.supabaseUrl, publicConfig.supabaseAnonKey)
        : null,
    [publicConfig],
  );
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(Boolean(publicConfig));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setAuthLoading(false);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthLoading(false);
      if (!nextSession) {
        setTranscript([]);
        setChatError(null);
      }
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  async function login(event: FormEvent) {
    event.preventDefault();
    if (loginBusy) return;
    if (!supabase) {
      setLoginError(GENERIC_ERRORS.config);
      return;
    }
    setLoginBusy(true);
    setLoginError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) setLoginError("No fue posible iniciar sesión. Revisa tu correo y contraseña.");
    setLoginBusy(false);
  }

  async function logout() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setSession(null);
    setTranscript([]);
    setMessage("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = message.trim();
    if (!clean || busy) return;
    const token = session?.access_token;
    if (!token) {
      setChatError(GENERIC_ERRORS.auth);
      return;
    }

    setBusy(true);
    setChatError(null);
    try {
      const endpoint = requiredPublicEnv("NEXT_PUBLIC_CHAT_FUNCTION_URL");
      const response = await fetch(endpoint, buildChatRequest(token, clean));
      if (!response.ok) {
        setChatError(safeChatError(response.status));
        return;
      }
      const payload: unknown = await response.json();
      const parsed = validateChatResponse(payload);
      setTranscript((items) => [
        ...items,
        {
          id: `${Date.now()}-${items.length}`,
          question: clean,
          response: parsed,
        },
      ]);
      setMessage("");
    } catch (error) {
      setChatError(error instanceof Error ? error.message : GENERIC_ERRORS.network);
    } finally {
      setBusy(false);
    }
  }

  function setFeedback(id: string, feedback: TranscriptItem["feedback"]) {
    setTranscript((items) => items.map((item) => (item.id === id ? { ...item, feedback } : item)));
  }

  const view = getAuthView(authLoading, session);
  if (view === "loading") {
    return (
      <section className="panel" aria-busy="true">
        <p className="muted">Cargando sesión…</p>
      </section>
    );
  }

  if (!publicConfig || !supabase) {
    return (
      <section className="panel" role="alert">
        <p className="eyebrow">Configuración requerida</p>
        <h1>Chat no configurado</h1>
        <p className="muted">
          Falta configurar las variables públicas de Supabase o la URL del chat.
        </p>
      </section>
    );
  }

  if (view === "login") {
    return (
      <section className="panel authPanel" aria-labelledby="login-title">
        <div>
          <p className="eyebrow">Acceso piloto</p>
          <h1 id="login-title">Inicia sesión</h1>
          <p className="muted">Usa tu usuario interno autorizado para consultar conocimiento.</p>
        </div>
        <form className="authForm" onSubmit={login}>
          <label>
            Correo
            <input
              autoComplete="email"
              inputMode="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Contraseña
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {loginError ? (
            <p className="error" role="alert">
              {loginError}
            </p>
          ) : null}
          <button type="submit" disabled={loginBusy || !email.trim() || !password}>
            {loginBusy ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
      </section>
    );
  }

  return (
    <>
      <header className="topbar">
        <div>
          <strong>Knowledge MVP</strong>
          <span>{session?.user.email}</span>
        </div>
        <button type="button" className="secondaryButton" onClick={logout}>
          Salir
        </button>
      </header>
      <main className="shell">
        <section className="intro" aria-labelledby="chat-title">
          <p className="eyebrow">Base de conocimiento interna</p>
          <h1 id="chat-title">¿En qué puedo ayudarte?</h1>
          <p className="muted">
            Las respuestas se basan únicamente en contenido interno publicado.
          </p>
        </section>

        <section className="chatSurface" aria-label="Conversación">
          <div className="transcript">
            {transcript.length === 0 ? (
              <p className="emptyState">
                Haz una pregunta sobre los procedimientos publicados para iniciar la conversación.
              </p>
            ) : (
              transcript.map((item) => (
                <article className="turn" key={item.id}>
                  <div className="questionBubble">
                    <span>Pregunta</span>
                    <p>{item.question}</p>
                  </div>
                  <AnswerCard
                    item={item}
                    onFeedback={(feedback) => setFeedback(item.id, feedback)}
                  />
                </article>
              ))
            )}
          </div>

          {chatError ? (
            <p className="error" role="alert">
              {chatError}
            </p>
          ) : null}

          <form className="composer" onSubmit={submit}>
            <label className="srOnly" htmlFor="question">
              Pregunta
            </label>
            <textarea
              id="question"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Escribe tu pregunta…"
              rows={3}
              maxLength={4000}
            />
            <button type="submit" disabled={busy || !message.trim()}>
              {busy ? "Consultando…" : "Preguntar"}
            </button>
          </form>
        </section>
      </main>
    </>
  );
}

function AnswerCard({
  item,
  onFeedback,
}: {
  item: TranscriptItem;
  onFeedback: (feedback: TranscriptItem["feedback"]) => void;
}) {
  const { response } = item;
  const sources = publicSourcesFor(response);

  return (
    <div className={response.insufficient_evidence ? "answerCard insufficient" : "answerCard"}>
      <span>{response.insufficient_evidence ? "Información insuficiente" : "Respuesta"}</span>
      <p>{response.answer}</p>

      {sources.length > 0 ? (
        <div className="sources">
          <strong>Fuentes</strong>
          <ul>
            {sources.map((source, index) => (
              <li key={`${source.label ?? index}-${source.title}-${source.section ?? ""}`}>
                {source.sourceUrl ? (
                  <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer">
                    {source.title}
                  </a>
                ) : (
                  <span>{source.title}</span>
                )}
                {source.section ? <small>{source.section}</small> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="feedback" aria-label="Calificar respuesta">
        <button
          type="button"
          className={item.feedback === "useful" ? "selectedFeedback" : ""}
          onClick={() => onFeedback("useful")}
          aria-pressed={item.feedback === "useful"}
        >
          Útil
        </button>
        <button
          type="button"
          className={item.feedback === "not_useful" ? "selectedFeedback" : ""}
          onClick={() => onFeedback("not_useful")}
          aria-pressed={item.feedback === "not_useful"}
        >
          No útil
        </button>
      </div>
    </div>
  );
}

function sanitizeCitations(value: unknown): PublicCitation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.title !== "string" || item.title.trim() === "") {
      return [];
    }
    return [
      {
        ...(typeof item.label === "string" && item.label.trim()
          ? { label: item.label.trim() }
          : {}),
        title: item.title.trim(),
        ...(typeof item.section === "string" && item.section.trim()
          ? { section: item.section.trim() }
          : {}),
        ...(typeof item.sourceUrl === "string" && item.sourceUrl.trim()
          ? { sourceUrl: item.sourceUrl.trim() }
          : {}),
      },
    ];
  });
}

function requiredPublicEnv(
  name:
    "NEXT_PUBLIC_SUPABASE_URL" | "NEXT_PUBLIC_SUPABASE_ANON_KEY" | "NEXT_PUBLIC_CHAT_FUNCTION_URL",
): string {
  const config = readPublicConfig();
  const value =
    name === "NEXT_PUBLIC_SUPABASE_URL"
      ? config?.supabaseUrl
      : name === "NEXT_PUBLIC_SUPABASE_ANON_KEY"
        ? config?.supabaseAnonKey
        : config?.chatFunctionUrl;
  if (!value) throw new Error(GENERIC_ERRORS.config);
  return value;
}

function readPublicConfig(): {
  supabaseUrl: string;
  supabaseAnonKey: string;
  chatFunctionUrl: string;
} | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const chatFunctionUrl = process.env.NEXT_PUBLIC_CHAT_FUNCTION_URL;
  if (!supabaseUrl || !supabaseAnonKey || !chatFunctionUrl) return null;
  return { supabaseUrl, supabaseAnonKey, chatFunctionUrl };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
