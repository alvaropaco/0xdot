import { useEffect, useState } from "react";
import { fetchRuntimeHealth, type RuntimeHealth } from "../lib/tauri-runtime";

type Status = { kind: "checking" } | { kind: "ok"; health: RuntimeHealth } | { kind: "error" };

/**
 * First screen of the local-first desktop: the UI shipped inside the app
 * talking to the embedded Rust runtime. Until the runtime answers chat
 * (milestone M1) this is the whole app.
 */
export function LocalRuntimeGate() {
  const [status, setStatus] = useState<Status>({ kind: "checking" });

  useEffect(() => {
    let active = true;
    fetchRuntimeHealth()
      .then((health) => active && setStatus({ kind: "ok", health }))
      .catch(() => active && setStatus({ kind: "error" }));
    return () => {
      active = false;
    };
  }, []);

  const healthLine =
    status.kind === "checking"
      ? "Health: checking…"
      : status.kind === "error"
        ? "Health: runtime unreachable"
        : status.health.rpcReady
          ? "Health: online"
          : "Health: online — native chat arrives with the runtime milestone.";

  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div className="w-[min(28rem,90vw)] rounded-xl border border-border bg-card p-6">
        <h1 className="text-lg font-semibold">0xdot</h1>
        <p className="mt-2 text-sm text-muted-foreground" data-testid="runtime-status">
          {status.kind === "ok"
            ? `Runtime: ${status.health.mode} · v${status.health.version}`
            : "Runtime: local"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{healthLine}</p>
      </div>
    </main>
  );
}
