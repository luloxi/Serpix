"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { landingCopy, LANDING_LANG_STORAGE_KEY, type LandingLang } from "@/lib/landing-copy";
import "./landing.css";

const REPO = "https://github.com/luloxi/Serpix";

function storedLang(): LandingLang | null {
  try {
    const value = window.localStorage.getItem(LANDING_LANG_STORAGE_KEY);
    return value === "en" || value === "es" ? value : null;
  } catch {
    return null;
  }
}

function remember(lang: LandingLang) {
  try {
    window.localStorage.setItem(LANDING_LANG_STORAGE_KEY, lang);
  } catch {
    /* private mode */
  }
}

export default function Landing({ initialLang = "es" }: { initialLang?: LandingLang }) {
  const [lang, setLang] = useState<LandingLang>(initialLang);
  const copy = landingCopy[lang];

  // Server HTML is Spanish unless ?lang=en. Apply a saved choice on the next tick so
  // the first render matches the server (localStorage is not available there).
  useEffect(() => {
    const id = window.setTimeout(() => {
      const fromUrl = new URLSearchParams(window.location.search).get("lang");
      if (fromUrl === "en" || fromUrl === "es") {
        remember(fromUrl);
        return;
      }
      const stored = storedLang();
      if (stored) setLang(stored);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  function toggle() {
    const next: LandingLang = lang === "es" ? "en" : "es";
    setLang(next);
    remember(next);
    const url = new URL(window.location.href);
    if (url.searchParams.has("lang")) {
      url.searchParams.set("lang", next);
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  }

  return (
    <div className="landing" lang={lang}>
      <div className="landing-accent" aria-hidden="true" />
      <header className="landing-header">
        <button
          type="button"
          className="landing-lang"
          onClick={toggle}
          aria-pressed={lang === "en"}
          aria-label={copy.langLabel}
        >
          {copy.langButton}
        </button>
      </header>
      <main className="landing-main">
        <div className="landing-mark">
          <img
            className="landing-logo"
            src="/icons/logo-128.v5.png"
            srcSet="/icons/logo-128.v5.png 128w, /icons/icon-192.v5.png 192w"
            sizes="(min-width: 720px) 104px, 88px"
            alt=""
            width={88}
            height={88}
          />
        </div>
        <h1>{copy.title}</h1>
        <p className="landing-lead">{copy.description}</p>
        <p className="landing-invite">{copy.inviteOnly}</p>
        <Link className="landing-enter" href="/login" prefetch={false}>{copy.enter}</Link>
        <p className="landing-note">{copy.inviteNote}</p>
        <section className="landing-block" aria-labelledby="landing-features-title">
          <h2 id="landing-features-title">{copy.featuresLabel}</h2>
          <ul className="landing-features">
            {copy.features.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
        <section className="landing-limits" aria-labelledby="landing-limits-title">
          <h2 id="landing-limits-title">{copy.limitsTitle}</h2>
          <ul>
            {copy.limits.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      </main>
      <footer className="landing-footer">
        <p><a href={REPO}>{copy.license}</a></p>
        <p>{copy.madeBy}</p>
      </footer>
    </div>
  );
}
