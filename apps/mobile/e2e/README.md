# Mobile emulator smoke test

This opt-in [Maestro](https://maestro.mobile.dev/) flow exercises bot creation,
thread messaging, and computer takeover/release on a real Android emulator or iOS simulator. It
expects a running Rakazo stack and deliberately stays out of ordinary pull-request CI.

## Prerequisites

1. Install the Maestro CLI and start an Android emulator or iOS simulator.
2. Start Rakazo's database, API, worker, and sandbox supervisor. The computer portion requires a
   working sandbox provider (the normal local Docker provider is sufficient).
3. Build/install the native app with an API URL that the emulator can reach. For the standard local
   ports, use `http://10.0.2.2:3100` on the Android emulator and `http://127.0.0.1:3100` on the iOS
   simulator. For example:

   ```sh
   EXPO_PUBLIC_API_URL=http://10.0.2.2:3100 pnpm --filter @rakazo/mobile android
   ```

## Run

```sh
pnpm --filter @rakazo/mobile test:e2e -- \
  -e RAKAZO_E2E_MESSAGE=mobile-smoke-message
```

To point the app at a different server at run time, pass `-e RAKAZO_MOBILE_API_URL=…`; the flow
opens Settings → Server and saves it before the assertions.

`clearState` resets the app's locally stored server and Space selection; it does not delete
server-side bots.

## Screenshot catalog

Run **Actions → mobile Android screenshots → Run workflow** to build the app, seed an isolated fake
workspace, capture light and dark Android emulator views, upload diagnostics for seven days, and publish a
persistent gallery beside the Playwright reports.
