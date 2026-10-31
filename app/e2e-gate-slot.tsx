"use client";

import dynamic from "next/dynamic";

function GateFallback() {
  return <p className="e2e-loading" role="status">Cargando el cifrado…</p>;
}

const E2eGate = dynamic(() => import("./e2e-gate"), { ssr: false, loading: GateFallback });

type Props = {
  userId: string;
  encryptionMode: string | null;
  name: string;
  email: string;
  image: string | null;
};

/** Browser-only. The gate imports the engine, and that graph is shimmed for the browser build only. */
export default function E2eGateSlot(props: Props) {
  return <E2eGate {...props} />;
}
