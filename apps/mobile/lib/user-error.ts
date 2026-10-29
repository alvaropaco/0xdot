import { isVoiceAccountErrorCode } from "@rakazo/contracts";
import { isServerUnreachable, userErrorMessage } from "@rakazo/core";
import { t } from "./i18n";

/** Text for a failure: human messages pass through; network and implementation detail become copy. */
export function errorText(
  error: unknown,
  fallback = t("Something went wrong. Try again."),
): string {
  return (
    voiceAccountErrorText(error) ??
    userErrorMessage(error, { fallback, offline: t("Could not reach the server") })
  );
}

/** Text for an error or `/api/voice` body whose code says the voice account needs attention. */
export function voiceAccountErrorText(error: unknown): string | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (!isVoiceAccountErrorCode(code)) return undefined;
  return code === "VOICE_OUT_OF_CREDIT"
    ? t("Your voice provider is out of credit.")
    : t("Your voice provider key was rejected.");
}

export type LoadFailureKind = "offline" | "server" | "other";

/** Why a load failed, when the error says: no answer or a server fault. */
export function loadFailureKind(error: unknown): LoadFailureKind {
  if (isServerUnreachable(error)) return "offline";
  const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  if (typeof status === "number" && status >= 500) return "server";
  return "other";
}

/** Keep useful boot details; the screen supplies the recovery title and copy. */
export function computerBootErrorDetail(error: unknown): string | null {
  if (isServerUnreachable(error) || loadFailureKind(error) === "server") return null;
  const detail = errorText(error, "");
  return !detail ||
    /^(?:internal server error|server error|http\s+5\d{2}\b|5\d{2}\b)|time[ -]?out|timed out/i.test(
      detail,
    )
    ? null
    : detail;
}
