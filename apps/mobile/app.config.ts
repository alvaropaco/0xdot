import type { ConfigContext, ExpoConfig } from "expo/config";

const RELEASE_PROFILES = new Set(["production", "android-apk"]);

export default ({ config }: ConfigContext): ExpoConfig => {
  if (RELEASE_PROFILES.has(process.env.EAS_BUILD_PROFILE ?? "")) {
    const apiUrl = process.env.EXPO_PUBLIC_API_URL;
    if (!apiUrl) {
      throw new Error(
        "EXPO_PUBLIC_API_URL must be set in the EAS production environment before building a release.",
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      throw new Error("EXPO_PUBLIC_API_URL must be a valid URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("EXPO_PUBLIC_API_URL must use HTTPS for production builds.");
    }
  }

  let result = config as ExpoConfig;

  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;
  if (googleServicesFile) {
    result = { ...result, android: { ...result.android, googleServicesFile } };
  }

  // Native crash handling autolinks; upload build hooks are optional and require credentials.
  if (process.env.SENTRY_AUTH_TOKEN) {
    result = {
      ...result,
      plugins: [
        ...(result.plugins ?? []),
        [
          "@sentry/react-native/expo",
          {
            organization: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            url: process.env.SENTRY_URL,
          },
        ],
      ],
    };
  }
  return result;
};
