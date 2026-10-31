"use client";

import { useEffect } from "react";

/** Mounts nothing. The engine chunk loads only when a session asks for it, via dynamic import. */
export function E2eEngineHost() {
  useEffect(() => {
    if (window.sessionStorage.getItem("serpix-e2e-boot") === "1") void import("@/lib/e2e/engine");
  }, []);
  return null;
}
