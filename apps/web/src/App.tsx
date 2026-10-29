import { Trans } from "@lingui/react/macro";
import type { LinkFavicons } from "@rakazo/chat-ui/web";
import { LinkFaviconsContext, RemoteImagesContext } from "@rakazo/chat-ui/web";
import { analyticsScreen } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { Suspense, useEffect, useRef, useSyncExternalStore } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { getTicketBoardEnabled, subscribeTicketBoardEnabled } from "./lib/bootstrap";
import { desktopBridge } from "./lib/desktop";
import { lazyComponent } from "./lib/preload-recovery";
import { getRemoteImagesEnabled, subscribeRemoteImages } from "./lib/remote-images-preference";
import { rpc } from "./lib/rpc";
import { IntegrationCallbackPage } from "./pages/IntegrationCallback";
import { IntegrationSetupPage } from "./pages/IntegrationSetup";
import { McpOAuthCallbackPage } from "./pages/McpOAuthCallback";
import { ShellPage } from "./pages/Shell";

const OnboardingPage = lazyComponent(() =>
  import("./pages/Onboarding").then((module) => module.OnboardingPage),
);
const ArtifactsPage = lazyComponent(() =>
  import("./pages/Artifacts").then((module) => module.ArtifactsPage),
);
const BoardPage = lazyComponent(() => import("./pages/Board").then((module) => module.BoardPage));

// Link icons come from our API, which fetches and caches them; the browser never asks the site.
const linkFavicons: LinkFavicons = {
  load: (origin) => rpc.links.favicon({ origin }),
};

export function App() {
  const loadRemoteImages = useSyncExternalStore(
    subscribeRemoteImages,
    getRemoteImagesEnabled,
    () => false,
  );
  return (
    <RemoteImagesContext.Provider value={loadRemoteImages}>
      <LinkFaviconsContext.Provider value={linkFavicons}>
        <ErrorBoundary fallback={<AppFailed />}>
          {window.location.pathname === "/integrations/callback" ? (
            <IntegrationCallbackPage />
          ) : (
            <AppRoutes />
          )}
        </ErrorBoundary>
      </LinkFaviconsContext.Provider>
    </RemoteImagesContext.Provider>
  );
}

function AppRoutes() {
  const ticketBoardEnabled = useSyncExternalStore(
    subscribeTicketBoardEnabled,
    getTicketBoardEnabled,
    () => false,
  );
  const pathname = useLocation().pathname;
  const screen = analyticsScreen(pathname);
  const lastScreen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!screen) return;
    if (lastScreen.current === screen) return;
    lastScreen.current = screen;
    void Promise.resolve()
      .then(() => rpc.analytics.screen({ screen, surface: desktopBridge() ? "desktop" : "web" }))
      .catch(() => undefined);
  }, [screen]);

  return (
    <div className="h-full" data-rakazo-app-state="ready">
      <Suspense fallback={<div className="h-full bg-background" />}>
        <Routes>
          <Route path="/" element={<Navigate to="/app" replace />} />
          <Route path="/mcp/oauth/callback" element={<McpOAuthCallbackPage />} />
          <Route path="/integrations/setup" element={<IntegrationSetupPage />} />
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
          <Route path="/app" element={<ShellPage />} />
          <Route path="/app/g/:groupId" element={<ShellPage />} />
          <Route path="/app/artifacts" element={<ArtifactsPage />} />
          <Route path="/app/artifacts/:artifactId" element={<ArtifactsPage />} />
          {ticketBoardEnabled ? <Route path="/app/board" element={<BoardPage />} /> : null}
          <Route path="/app/:botId" element={<ShellPage />} />
        </Routes>
      </Suspense>
    </div>
  );
}

/** Last resort for a render failure no inner boundary caught: offer a reload instead of a blank page. */
function AppFailed() {
  return (
    <div
      className="grid h-full place-items-center bg-background px-6 text-center"
      data-rakazo-app-state="failed"
    >
      <div className="flex flex-col items-center">
        <p className="text-[13.5px] text-muted-foreground/80">
          <Trans>Something went wrong. Try again.</Trans>
        </p>
        <div className="mt-4">
          <Button
            variant="secondary"
            className="rounded-full"
            onClick={() => window.location.reload()}
          >
            <Trans>Refresh</Trans>
          </Button>
        </div>
      </div>
    </div>
  );
}
