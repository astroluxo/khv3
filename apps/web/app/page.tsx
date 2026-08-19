import { Chat } from "@/components/chat";

export default function HomePage() {
  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">Base de conocimiento interna</p>
          <h1>¿En qué puedo ayudarte?</h1>
          <p className="subtle">
            Las respuestas se basan únicamente en contenido interno publicado.
          </p>
        </div>
      </header>
      <Chat />
    </main>
  );
}
