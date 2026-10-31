"use client";

import dynamic from "next/dynamic";

const E2eEngineHost = dynamic(() => import("./e2e-host").then((mod) => mod.E2eEngineHost), { ssr: false });

/** Client-only mount. Keeps the engine and its route graph out of the server build. */
export function E2eEngineSlot() {
  return <E2eEngineHost />;
}
