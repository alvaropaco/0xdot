import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Label,
  NativeSelect,
  NativeSelectOption,
  OptionSelect,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import { Disclosure } from "@rakazo/ui-web/components/ui/disclosure";
import type { RefObject } from "react";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import { ComputersUnavailableHint } from "../components/ComputersUnavailableHint";
import { DesktopUpdateSection } from "../components/DesktopUpdates";
import type { BotsSidebarDensity } from "../lib/bots-sidebar-density-pref";
import {
  getBotsSidebarDensity,
  setBotsSidebarDensity,
  subscribeBotsSidebarDensity,
} from "../lib/bots-sidebar-density-pref";
import {
  getComposerEnterToSend,
  setComposerEnterToSend,
  subscribeComposerEnterToSend,
} from "../lib/composer-enter-to-send-pref";
import { getActiveUiLocale, setUiLocale } from "../lib/i18n";
import { localTimezone, sameTimeZone, timezoneOptions } from "../lib/local-timezone";
import {
  getRemoteImagesPreference,
  setRemoteImagesPreference,
} from "../lib/remote-images-preference";
import {
  getResponseStreamingPreference,
  setResponseStreamingPreference,
} from "../lib/response-streaming";
import {
  getToolActivityPreference,
  setToolActivityPreference,
} from "../lib/tool-activity-preference";
import type { AppearancePreference } from "../lib/ui-appearance";
import { getUiAppearancePreference, setUiAppearance } from "../lib/ui-appearance";
import type { UiLocale } from "../lib/ui-locale";
import { UI_LOCALE_LABELS, UI_LOCALES } from "../lib/ui-locale";

export function GeneralSettingsPanels({
  timezone = null,
  onTimezoneChange,
  messagingEnabled = false,
  onOpenMessaging,
}: {
  /** The user's saved IANA timezone, or null before one is set. */
  timezone?: string | null;
  onTimezoneChange?: (timezone: string) => Promise<void>;
  messagingEnabled?: boolean;
  onOpenMessaging?: () => void;
}) {
  const { t } = useLingui();
  const [locale, setLocale] = useState<UiLocale>(() => getActiveUiLocale());
  const localeRequestRef = useRef(0);
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    getUiAppearancePreference(),
  );
  const sidebarDensity = useSyncExternalStore(
    subscribeBotsSidebarDensity,
    getBotsSidebarDensity,
    () => "comfortable",
  );
  const sidebarDensityLabelId = useId();
  const [streamReplies, setStreamReplies] = useState(
    () => getResponseStreamingPreference() === "on",
  );
  const streamRepliesId = useId();
  const [showToolActivity, setShowToolActivity] = useState(
    () => getToolActivityPreference() === "on",
  );
  const showToolActivityId = useId();
  const enterToSend = useSyncExternalStore(
    subscribeComposerEnterToSend,
    getComposerEnterToSend,
    () => false,
  );
  const enterToSendId = useId();
  const [loadRemoteImages, setLoadRemoteImages] = useState(
    () => getRemoteImagesPreference() === "on",
  );
  const loadRemoteImagesId = useId();
  const timezoneId = useId();
  const [timezonePending, setTimezonePending] = useState(false);
  const [timezoneError, setTimezoneError] = useState<string | null>(null);
  const deviceTimezone = localTimezone();

  function chooseLocale(next: UiLocale) {
    if (next === locale) return;
    const requestId = ++localeRequestRef.current;
    setLocale(next);
    void setUiLocale(next).then((activated) => {
      if (requestId !== localeRequestRef.current) return;
      setLocale(activated);
    });
  }

  async function chooseTimezone(next: string) {
    if (!onTimezoneChange || timezonePending || next === timezone) return;
    setTimezonePending(true);
    setTimezoneError(null);
    try {
      await onTimezoneChange(next);
    } catch {
      setTimezoneError(t`Couldn't update your timezone`);
    } finally {
      setTimezonePending(false);
    }
  }

  return (
    <div className="space-y-5">
      {messagingEnabled && onOpenMessaging ? (
        <section className="rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Messaging</Trans>
          </h3>
          <Button variant="secondary" className="mt-3 rounded-full" onClick={onOpenMessaging}>
            <Trans>Manage messaging settings</Trans>
          </Button>
        </section>
      ) : null}

      <section className="rounded-xl border border-border px-4 py-4">
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Appearance</Trans>
        </h3>
        <AppearancePicker
          value={appearance}
          onChange={(next) => {
            setAppearance(next);
            setUiAppearance(next);
          }}
        />
        <div className="mt-4 flex items-center justify-between gap-3">
          <span id={sidebarDensityLabelId} className="text-[13px] text-foreground/75">
            <Trans>Sidebar density</Trans>
          </span>
          <ToggleGroup
            aria-labelledby={sidebarDensityLabelId}
            data-testid="bots-sidebar-density-select"
            value={[sidebarDensity]}
            onValueChange={([next]) => {
              if (next) setBotsSidebarDensity(next as BotsSidebarDensity);
            }}
            spacing={1}
            className="grid min-w-0 grid-cols-2 rounded-lg bg-muted p-1"
          >
            <ToggleGroupItem
              value="comfortable"
              data-testid="bots-sidebar-density-comfortable"
              className="text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
            >
              <Trans>Comfortable</Trans>
            </ToggleGroupItem>
            <ToggleGroupItem
              value="compact"
              data-testid="bots-sidebar-density-compact"
              className="text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
            >
              <Trans>Compact</Trans>
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </section>

      <section className="rounded-xl border border-border px-4 py-4">
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Language</Trans>
        </h3>
        <UiLocalePicker value={locale} onChange={chooseLocale} />
      </section>

      {onTimezoneChange ? (
        <section
          className="rounded-xl border border-border px-4 py-4"
          data-testid="timezone-settings"
        >
          <h3 id={timezoneId} className="text-[15px] font-medium text-foreground">
            <Trans>Timezone</Trans>
          </h3>
          <NativeSelect
            aria-labelledby={timezoneId}
            data-testid="timezone-select"
            value={timezone ?? deviceTimezone}
            disabled={timezonePending}
            onChange={(event) => void chooseTimezone(event.target.value)}
            className="mt-3 w-full"
          >
            {timezoneOptions(timezone ?? deviceTimezone).map((zone) => (
              <NativeSelectOption key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {!timezone || !sameTimeZone(timezone, deviceTimezone) ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 h-auto max-w-full py-1.5 text-left whitespace-normal"
              disabled={timezonePending}
              data-testid="timezone-use-device"
              onClick={() => void chooseTimezone(deviceTimezone)}
            >
              <Trans comment="Switches the saved timezone to this device's, e.g. 'Use Pacific/Auckland'">
                Use {deviceTimezone.replaceAll("_", " ")}
              </Trans>
            </Button>
          ) : null}
          {timezoneError ? (
            <p role="alert" className="mt-3 text-[12.5px] text-destructive">
              {timezoneError}
            </p>
          ) : null}
        </section>
      ) : null}

      <Disclosure
        data-testid="advanced-settings"
        className="group rounded-xl border border-border"
        summary={<Trans>Advanced</Trans>}
        summaryClassName="w-full flex items-center justify-between gap-4 px-4 py-4 text-[14px] text-foreground/75"
      >
        <div className="border-t border-border px-4 pb-5">
          <div className="flex items-start gap-3 pt-5">
            <Switch
              id={enterToSendId}
              data-testid="composer-enter-to-send-toggle"
              className="mt-0.5"
              checked={enterToSend}
              onCheckedChange={(checked) => setComposerEnterToSend(checked)}
            />
            <Label htmlFor={enterToSendId} className="text-[14px] font-normal text-foreground/75">
              <Trans>Send with Enter</Trans>
            </Label>
          </div>
          <div className="flex items-start gap-3 pt-5">
            <Switch
              id={streamRepliesId}
              data-testid="response-streaming-toggle"
              className="mt-0.5"
              checked={streamReplies}
              onCheckedChange={(checked) => {
                setStreamReplies(checked);
                setResponseStreamingPreference(checked ? "on" : "off");
              }}
            />
            <Label htmlFor={streamRepliesId} className="text-[14px] font-normal text-foreground/75">
              <Trans>Stream replies</Trans>
            </Label>
          </div>
          <div className="flex items-start gap-3 pt-4">
            <Switch
              id={showToolActivityId}
              data-testid="tool-activity-toggle"
              className="mt-0.5"
              checked={showToolActivity}
              onCheckedChange={(checked) => {
                setShowToolActivity(checked);
                setToolActivityPreference(checked ? "on" : "off");
              }}
            />
            <Label
              htmlFor={showToolActivityId}
              className="text-[14px] font-normal text-foreground/75"
            >
              <Trans>Show tool activity</Trans>
            </Label>
          </div>
          <div className="flex items-start gap-3 pt-4">
            <Switch
              id={loadRemoteImagesId}
              data-testid="remote-images-toggle"
              className="mt-0.5"
              checked={loadRemoteImages}
              onCheckedChange={(checked) => {
                setLoadRemoteImages(checked);
                setRemoteImagesPreference(checked ? "on" : "off");
              }}
            />
            <Label
              htmlFor={loadRemoteImagesId}
              className="text-[14px] font-normal text-foreground/75"
            >
              <Trans>Load web images automatically</Trans>
            </Label>
          </div>
        </div>
      </Disclosure>
    </div>
  );
}

export function UsageSettingsPanel({
  usage,
  panelRef,
}: {
  usage?: {
    runs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens?: number | null;
  } | null;
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-testid="usage-settings"
      className="rounded-xl border border-border px-4 py-4 outline-none"
    >
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Usage</Trans>
      </h3>
      {usage ? (
        <p className="mt-3 text-[14px] text-foreground/75">
          <Trans>
            {usage.runs} runs · {usage.totalTokens ?? "—"} tokens
          </Trans>
        </p>
      ) : null}
      <p className={`text-[12.5px] text-muted-foreground/80 ${usage ? "mt-2" : "mt-3"}`}>
        <Trans>Model spend uses your provider keys.</Trans>
      </p>
    </div>
  );
}

export function ComputerSettingsPanel({
  sandboxProvider,
  onSandboxProviderChange,
  onRecoveryDismissed,
}: {
  sandboxProvider?: string | null;
  onSandboxProviderChange?: (sandboxProvider: string) => void;
  onRecoveryDismissed?: () => void;
}) {
  return (
    <div
      data-testid="computers-setup-settings"
      className="rounded-xl border border-border px-4 py-4"
    >
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Computers</Trans>
      </h3>
      <ComputersUnavailableHint
        className="mt-3 text-[13px] leading-relaxed text-muted-foreground"
        sandboxProvider={sandboxProvider}
        onRecovered={onSandboxProviderChange}
        onRecoveryDismissed={onRecoveryDismissed}
      />
    </div>
  );
}

export function UpdatesSettingsPanel() {
  return (
    <div className="space-y-5">
      <DesktopUpdateSection />
    </div>
  );
}

function AppearancePicker({
  value,
  onChange,
}: {
  value: AppearancePreference;
  onChange: (next: AppearancePreference) => void;
}) {
  const { t } = useLingui();
  const options: { value: AppearancePreference; label: string }[] = [
    { value: "system", label: t`System` },
    { value: "light", label: t`Light` },
    { value: "dark", label: t`Dark` },
  ];

  return (
    <ToggleGroup
      aria-label={t`Appearance`}
      data-testid="ui-appearance-select"
      value={[value]}
      onValueChange={([next]) => {
        if (next) onChange(next as AppearancePreference);
      }}
      spacing={1}
      className="mt-3 grid w-full min-w-0 grid-cols-3 rounded-lg bg-muted p-1"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          data-testid={`ui-appearance-${option.value}`}
          className="text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function UiLocalePicker({
  value,
  onChange,
}: {
  value: UiLocale;
  onChange: (locale: UiLocale) => void;
}) {
  const { t } = useLingui();
  return (
    <OptionSelect
      className="mt-3"
      data-testid="ui-locale-select"
      aria-label={t`Language`}
      options={UI_LOCALES.map((code) => ({ value: code, label: UI_LOCALE_LABELS[code] }))}
      value={value}
      onValueChange={onChange}
    />
  );
}
