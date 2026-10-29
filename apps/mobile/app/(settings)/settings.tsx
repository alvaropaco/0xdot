import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppMark } from "../../components/app-mark";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import {
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  SettingsSwitch,
  useStackedSettings,
} from "../../components/settings-group";
import { currentApiBase, rpc, selectedSpaceId } from "../../lib/api";
import { formatUpdateLabel, getAppVersionInfo } from "../../lib/app-version";
import {
  getCachedAppearancePreference,
  mobileTokens,
  setAppearancePreference,
} from "../../lib/appearance";
import { archivedChatCounts, loadArchivedChats } from "../../lib/archived-chats";
import { useI18n } from "../../lib/i18n";
import type { LiveNotificationSettings } from "../../lib/live-notifications";
import {
  canPostPromotedNotifications,
  DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  getLiveNotificationSettings,
  hasLiveUpdateSettings,
  openLiveNotificationSettings,
  openPromotedNotificationSettings,
  setLiveNotificationSettings,
} from "../../lib/live-notifications";
import { native, useThemedStyles } from "../../lib/native";
import { registerPushToken } from "../../lib/push";
import { createQueuedSave } from "../../lib/queued-save";
import {
  getCachedRemoteImagesEnabled,
  setRemoteImagesPreference,
  subscribeRemoteImages,
} from "../../lib/remote-images-preference";
import {
  getCachedResponseStreamingEnabled,
  setResponseStreamingPreference,
  subscribeResponseStreaming,
} from "../../lib/response-streaming";
import { isSettingsLink, openFromSettingsSheet } from "../../lib/settings-sheet";
import { UI_LOCALE_LABELS } from "../../lib/ui-locale";
import { errorText } from "../../lib/user-error";

/** Render the app's settings, including the entry points for voice and integrations. */
export default function Settings() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const [usage, setUsage] = useState<{
    runs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens?: number | null;
  } | null>(null);
  const [notifications, setNotifications] = useState<LiveNotificationSettings>(
    DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  );
  const [notificationsReady, setNotificationsReady] = useState(Platform.OS !== "android");
  const notificationQueue = useRef<ReturnType<
    typeof createQueuedSave<LiveNotificationSettings>
  > | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [archivedCount, setArchivedCount] = useState(0);
  // A list that fails to refresh keeps its last count, so a passing error doesn't hide the row.
  const archivedCounts = useRef({ bots: 0, groups: 0 });
  const appearance = getCachedAppearancePreference();
  const streamReplies = useSyncExternalStore(
    subscribeResponseStreaming,
    getCachedResponseStreamingEnabled,
    () => false,
  );
  const loadRemoteImages = useSyncExternalStore(
    subscribeRemoteImages,
    getCachedRemoteImagesEnabled,
    () => false,
  );
  const loadRemoteImagesLabel = t("Load web images automatically");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const stackOptions = useStackedSettings();
  const styles = useThemedStyles(createSettingsStyles);
  const versionInfo = getAppVersionInfo();
  const updateLabel = formatUpdateLabel(versionInfo.update, t);
  const versionAccessibility = [versionInfo.nativeLabel, updateLabel].filter(Boolean).join(". ");

  useEffect(() => {
    void rpc<{
      runs: number;
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens?: number | null;
    }>("usage/summary")
      .then(setUsage)
      .catch(() => undefined);
    if (Platform.OS === "android") {
      void getLiveNotificationSettings()
        .then(setNotifications)
        .catch(() => undefined)
        .finally(() => setNotificationsReady(true));
    }
  }, []);

  const usageBlock = (
    <SettingsRow
      accessible
      title={t("Usage")}
      detail={
        usage
          ? t("{runs} runs · {tokens} tokens", {
              runs: usage.runs,
              tokens: usage.totalTokens ?? "—",
            })
          : undefined
      }
    />
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void loadArchivedChats().then((loaded) => {
        if (!active) return;
        archivedCounts.current = archivedChatCounts(archivedCounts.current, loaded);
        setArchivedCount(archivedCounts.current.bots + archivedCounts.current.groups);
      });
      return () => {
        active = false;
      };
    }, []),
  );

  function updateNotifications(next: LiveNotificationSettings) {
    notificationQueue.current ??= createQueuedSave(notifications, {
      onChange: setNotifications,
      equals: (a, b) =>
        a.liveConnection === b.liveConnection &&
        a.messages === b.messages &&
        a.scheduledTasks === b.scheduledTasks &&
        a.needsAttention === b.needsAttention,
      save: async (settings) => {
        await setLiveNotificationSettings(settings, currentApiBase(), selectedSpaceId() ?? "");
      },
      onSaved: async (settings) => {
        if (settings.liveConnection && !(await canPostPromotedNotifications())) {
          await openPromotedNotificationSettings();
        }
        await registerPushToken();
      },
      onError: (cause) =>
        setNotificationError(errorText(cause, t("Could not update notifications"))),
    });
    setNotificationError(null);
    notificationQueue.current.update(next);
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, stackOptions && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
      >
        {focus === "usage" ? <SettingsGroup>{usageBlock}</SettingsGroup> : null}
        {focus !== "usage" ? <SettingsGroup>{usageBlock}</SettingsGroup> : null}

        <View accessibilityLabel={t("Appearance")} style={styles.section}>
          <SettingsLabel>{t("Appearance")}</SettingsLabel>
          <NativeSegmentedControl
            accessibilityLabel={t("Appearance")}
            onChange={(value) => void setAppearancePreference(value)}
            options={[
              { value: "system", label: t("System") },
              { value: "light", label: t("Light") },
              { value: "dark", label: t("Dark") },
            ]}
            value={appearance}
          />
        </View>

        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            accessibilityLabel={t("Language")}
            accessibilityValue={{ text: UI_LOCALE_LABELS[locale] }}
            chevron="right"
            onPress={() => router.push("/language")}
            title={t("Language")}
            value={UI_LOCALE_LABELS[locale]}
          />
        </SettingsGroup>

        {Platform.OS === "android" ? (
          <SettingsGroup accessibilityLabel={t("Notifications")} label={t("Notifications")}>
            <SettingsSwitch
              label={t("Live working status")}
              value={notifications.liveConnection}
              disabled={!notificationsReady}
              onChange={(liveConnection) =>
                void updateNotifications({ ...notifications, liveConnection })
              }
            />
            <SettingsSwitch
              label={t("Agent messages")}
              detail={t("Replies and completed work")}
              value={notifications.messages}
              disabled={!notificationsReady}
              onChange={(messages) => void updateNotifications({ ...notifications, messages })}
            />
            <SettingsSwitch
              label={t("Scheduled tasks")}
              value={notifications.scheduledTasks}
              disabled={!notificationsReady}
              onChange={(scheduledTasks) =>
                void updateNotifications({ ...notifications, scheduledTasks })
              }
            />
            <SettingsSwitch
              label={t("Needs attention")}
              detail={t("Questions, approvals, takeover")}
              value={notifications.needsAttention}
              disabled={!notificationsReady}
              onChange={(needsAttention) =>
                void updateNotifications({ ...notifications, needsAttention })
              }
            />
            {hasLiveUpdateSettings() ? (
              <SettingsRow
                accessibilityRole="button"
                onPress={() => void openPromotedNotificationSettings()}
                title={t("Live update settings")}
              />
            ) : null}
            <SettingsRow
              accessibilityRole="button"
              onPress={() => void openLiveNotificationSettings()}
              title={t("Notification settings")}
            />
            {notificationError ? <Text style={styles.error}>{notificationError}</Text> : null}
          </SettingsGroup>
        ) : null}

        <SettingsGroup>
          {(
            [
              { title: t("Server"), href: "/server" },
              { title: t("Artifacts"), href: "/artifacts" },
              { title: t("Models"), href: "/models" },
              { title: t("Voice"), href: "/voice" },
              { title: t("Integrations"), href: "/integrations" },
              { title: t("AI data sharing"), href: "/ai-data-sharing" },
            ] as const
          ).map(({ title, href }) => (
            <SettingsRow
              key={href}
              accessibilityRole="button"
              chevron="right"
              // Artifacts lives on the root stack, so it closes the sheet before opening.
              onPress={() =>
                isSettingsLink(href) ? router.push(href) : openFromSettingsSheet(router, href)
              }
              title={title}
            />
          ))}
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            accessibilityLabel={t("Advanced")}
            accessibilityState={{ expanded: advancedOpen }}
            chevron={advancedOpen ? "down" : "right"}
            onPress={() => setAdvancedOpen((open) => !open)}
            title={t("Advanced")}
          />
          {advancedOpen ? (
            <SettingsSwitch
              label={t("Stream replies")}
              value={streamReplies}
              onChange={(checked) => void setResponseStreamingPreference(checked ? "on" : "off")}
            />
          ) : null}
          {advancedOpen ? (
            <SettingsSwitch
              label={loadRemoteImagesLabel}
              value={loadRemoteImages}
              onChange={(checked) => void setRemoteImagesPreference(checked ? "on" : "off")}
            />
          ) : null}
        </SettingsGroup>

        {archivedCount > 0 ? (
          <SettingsGroup>
            <SettingsRow
              accessibilityRole="button"
              chevron="right"
              onPress={() => router.push("/archived-bots")}
              title={t("Archived")}
              value={String(archivedCount)}
            />
          </SettingsGroup>
        ) : null}

        <View style={styles.about}>
          <AppMark />
          {versionInfo.nativeLabel || updateLabel ? (
            <View
              accessibilityLabel={versionAccessibility}
              accessibilityRole="summary"
              style={styles.versionFooter}
            >
              {versionInfo.nativeLabel ? (
                <Text style={styles.versionLine}>{versionInfo.nativeLabel}</Text>
              ) : null}
              {updateLabel ? <Text style={styles.versionLine}>{updateLabel}</Text> : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function createSettingsStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.groupedPage,
    },
    content: {
      flexGrow: 1,
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 32,
      gap: 28,
    },
    compactContent: {
      paddingHorizontal: 8,
    },
    section: {
      gap: 7,
    },
    about: {
      alignItems: "center",
      gap: 16,
      paddingTop: 8,
      paddingBottom: 22,
    },
    versionFooter: {
      alignItems: "center",
    },
    versionLine: {
      color: native.secondaryLabel,
      fontSize: 13,
      textAlign: "center",
    },
    error: {
      color: tokens.destructive,
      fontSize: 15,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
  });
}
