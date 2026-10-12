/**
 * Root layout: gesture root → theme → navigation stack.
 * Router chrome is disabled; screens render their own headers (Screen/Header)
 * so the design system owns every pixel.
 */
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { checkForUpdate, setPendingUpdate } from "../lib/updater";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as Notifications from "expo-notifications";

import { ProfilesProvider, useProfiles } from "../lib/profiles/ProfilesContext";
import { configureNotifications, ensureChannel } from "../lib/notificationPoster";
import { openChatWithBackStack, takePendingChatLink } from "../lib/chatDeepLink";
import { deliveryServiceUrl, registerForPush, PUSH_MARKER_KEY } from "../lib/pushRegistration";
import { startBackgroundPollingForProfile } from "../lib/backgroundPolling";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider";

/**
 * Root-level background polling lifecycle. The AppState listener lives here
 * (not in the chat screen) so backgrounding from ANY screen polls every
 * conversation whose notification mode resolves to ALL_MESSAGES.
 */
function BackgroundPollingLifecycle() {
  const { activeProfile } = useProfiles();
  const profileRef = useRef(activeProfile);
  profileRef.current = activeProfile;

  useEffect(() => {
    // The poller runs for the app's whole lifetime — foregrounded too — so
    // "All messages" notifications fire even while the app is open on another
    // screen. Per-conversation suppression is handled by setVisibleConversation.
    void startBackgroundPollingForProfile(profileRef.current);
    const sub = AppState.addEventListener("change", () => {
      void startBackgroundPollingForProfile(profileRef.current);
    });
    return () => sub.remove();
  }, [activeProfile]);

  return null;
}

const UPDATE_CHECK_KEY = "letta.update.lastCheck";
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h

/**
 * Push registration lifecycle (Phase 4 P3): register this device's REAL Expo
 * push token with the fleet delivery service. Runs on mount and on every
 * foreground (re-registration is idempotent — the service dedupes by token;
 * Android tokens can change on reinstall). Honest no-ops when the fleet
 * service is not configured (EXPO_PUBLIC_DELIVERY_SERVICE_URL), permission
 * is missing, or the Expo project is not provisioned yet (D5) — the app is
 * fully functional without push; the FGS poller remains the fallback.
 */
function PushRegistrationLifecycle() {
  useEffect(() => {
    const serviceUrl = deliveryServiceUrl();
    const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
    const run = async () => {
      if (!serviceUrl) return;
      await registerForPush(serviceUrl, {
        hasPermission: async () => {
          const { status } = await Notifications.getPermissionsAsync();
          return status === "granted";
        },
        getToken: async () => {
          const { data: token } = await Notifications.getExpoPushTokenAsync(
            projectId ? { projectId } : undefined,
          );
          return token;
        },
        platform: Platform.OS,
        register: async (url, pushToken, platform) => {
          const response = await fetch(`${url}/devices?userId=operator`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pushToken, platform }),
          });
          if (!response.ok) {
            throw new Error(`delivery service rejected registration (${response.status})`);
          }
        },
        readMarker: () => AsyncStorage.getItem(PUSH_MARKER_KEY),
        writeMarker: (token) => AsyncStorage.setItem(PUSH_MARKER_KEY, token),
        log: (message) => console.log(`[push] ${message}`),
      });
    };
    void run();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void run();
    });
    return () => sub.remove();
  }, []);

  return null;
}

/**
 * Checks for app updates on foreground, at most every 4h. Result is surfaced
 * through a module-level listener (the profile screen banner subscribes).
 */
function UpdateCheckLifecycle() {
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const last = Number((await AsyncStorage.getItem(UPDATE_CHECK_KEY)) ?? 0);
        if (Date.now() - last < UPDATE_CHECK_INTERVAL_MS) return;
        const result = await checkForUpdate();
        if (cancelled) return;
        if (result.updateAvailable) {
          setPendingUpdate({ version: result.manifest!.version, manifest: result.manifest! });
        }
        await AsyncStorage.setItem(UPDATE_CHECK_KEY, String(Date.now()));
      } catch {
        // Update checks are best-effort; never disturb the user.
      }
    };
    void run();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void run();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);
  return null;
}

function ThemedStack() {
  const { name, colors } = useTheme();
  return (
    <>
      <StatusBar style={name === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: "slide_from_right",
        }}
      />
    </>
  );
}

export default function RootLayout() {
  // Configure notifications once at app startup.
  useEffect(() => {
    void (async () => {
      await configureNotifications();
      await ensureChannel();
    })();
    // Cold-start deep link (conversation notification / shortcut): the
    // initial URL was redirected to "/" in +native-intent and the target
    // stashed. Rebuild the natural stack now that the navigator is ready.
    // This effect runs after the navigation container mounted (bottom-up
    // ordering), so the queued commands drain onto a ready container.
    const pending = takePendingChatLink();
    if (pending) {
      openChatWithBackStack(pending);
    }
    // Navigate to the conversation when a notification is tapped.
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as
        | { conversationId?: string; agentId?: string; agentName?: string }
        | undefined;
      if (data?.conversationId) {
        // Rebuild the natural stack (servers -> agents -> conversations ->
        // chat) so hardware back walks the chain instead of exiting the app.
        // Legacy notifications carry only conversationId — no agentId to
        // build the middle screens, so land on chat directly (old behavior).
        if (data.agentId) {
          openChatWithBackStack({
            conversationId: data.conversationId,
            agentId: data.agentId,
            agentName: data.agentName,
          });
        } else {
          // Same late-require pattern as before: _layout runs before the
          // router module would be safe to import at top level.
          const router = require("expo-router").router;
          router.push({
            pathname: "/chat",
            params: { conversationId: data.conversationId },
          });
        }
      }
    });
    return () => sub.remove();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <ProfilesProvider>
          <BackgroundPollingLifecycle />
      <UpdateCheckLifecycle />
      <PushRegistrationLifecycle />
          <BottomSheetModalProvider>
            <ThemedStack />
          </BottomSheetModalProvider>
        </ProfilesProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
