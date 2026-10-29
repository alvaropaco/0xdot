import { AppState } from "react-native";
import { currentApiBase, loadApiBase, requestHeaders, subscribeApiBase } from "./api";
import { configureMobileMonitoring, resetMobileMonitoring } from "./monitoring";

/** Independent of React: even an initial render failure must reach the collector. */
export function startMobileMonitoring(): void {
  let selectedBase: string | undefined;
  const configure = async () => {
    try {
      const base = currentApiBase();
      const headers = await requestHeaders();
      if (base === currentApiBase()) await configureMobileMonitoring(base, headers);
    } catch {
      /* Optional reporting must not become an unhandled startup rejection. */
    }
  };
  subscribeApiBase(() => {
    const base = currentApiBase();
    if (selectedBase !== undefined && selectedBase !== base) resetMobileMonitoring();
    selectedBase = base;
    void configure();
  });
  AppState.addEventListener("change", (state) => {
    if (state === "active") void configure();
  });
  void loadApiBase()
    .then(configure)
    .catch(() => undefined);
}
