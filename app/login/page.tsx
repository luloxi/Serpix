"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function signIn() {
    setLoading(true);
    setError("");
    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
      errorCallbackURL: "/login?error=oauth",
    });
    if (result.error) {
      setError("No se pudo iniciar sesión con Google. Intentá nuevamente.");
      setLoading(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="auth-brand-lockup"><img className="auth-brand-icon" src="/icon.svg" alt="" width="112" height="112" /><span>Serpix</span></div>
        <p className="eyebrow">GESTIÓN PERSONAL</p>
        <h1>Serpix</h1>
        <p className="auth-copy">Tu espacio de trabajo, relaciones y finanzas.</p>
        <button className="primary-button" onClick={signIn} disabled={loading}>
          {loading ? "Conectando con Google…" : "Continuar con Google"}
        </button>
        {error && <p className="error-message" role="alert">{error}</p>}
        <p className="auth-footnote">El acceso requiere aprobación del administrador.</p>
      </section>
    </main>
  );
}
