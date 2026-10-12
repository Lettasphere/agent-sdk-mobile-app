/**
 * Delivery-service push registration (Phase 4 P3). TRUE push on mobile —
 * unlike the desktop's D6 poll, the device registers its REAL Expo push
 * token with the fleet service (/devices API), and the service pushes
 * approvals + problems (completions are silent — same slate ruling).
 *
 * The FGS poller stays as the FALLBACK path (client strategy Phase 4): push
 * becomes primary when it is live; demotion is gated on the D5 credentials
 * landing, not on this pane.
 *
 * Effect-injected throughout (permission, token, platform, registration,
 * storage) so the flow is testable without a device or the Expo runtime —
 * and without importing react-native (its Flow-typed index breaks bun test).
 */

/** Build-time fleet config (EXPO_PUBLIC_* is embedded by the bundler). */
export function deliveryServiceUrl(env: Record<string, string | undefined> = process.env): string | null {
  const url = env.EXPO_PUBLIC_DELIVERY_SERVICE_URL;
  return url && url.length > 0 ? url : null;
}

export type PushRegistrationDeps = {
  /** True when the OS will show notifications (the app asks at most once). */
  hasPermission: () => Promise<boolean>;
  /** The device's Expo push token (getExpoPushTokenAsync). */
  getToken: () => Promise<string>;
  /** The device platform ("ios" | "android") — the service routes push on it. */
  platform: string;
  /** Register with the service: POST /devices?userId=operator. */
  register: (serviceUrl: string, pushToken: string, platform: string) => Promise<void>;
  /** Persist the registered marker (skip re-register churn within a session). */
  readMarker: () => Promise<string | null>;
  writeMarker: (token: string) => Promise<void>;
  log: (message: string) => void;
};

export const PUSH_MARKER_KEY = "letta.delivery.pushToken";

/**
 * Register for push when configured + permitted. Honest no-ops (not errors):
 * no service URL (fleet not deployed), no permission (the user said no),
 * token failure (Expo project not provisioned — the D5 ask). A changed token
 * re-registers; the service dedupes by (userId, pushToken).
 */
export async function registerForPush(
  serviceUrl: string | null,
  deps: PushRegistrationDeps,
): Promise<"registered" | "unregistered" | "no-service" | "no-permission" | "token-failed"> {
  if (!serviceUrl) return "no-service";
  if (!(await deps.hasPermission())) return "no-permission";
  let token: string;
  try {
    token = await deps.getToken();
  } catch (error) {
    // Expected until the Expo project is provisioned (D5): the projectId is
    // required for dev builds. Honest quiet — the app works, just no push.
    deps.log(`push token unavailable: ${String(error)}`);
    return "token-failed";
  }
  const previous = await deps.readMarker();
  if (previous === token) return "unregistered"; // already registered this token
  try {
    await deps.register(serviceUrl, token, deps.platform);
  } catch (error) {
    deps.log(`push registration failed: ${String(error)}`);
    return "unregistered";
  }
  await deps.writeMarker(token);
  return "registered";
}
