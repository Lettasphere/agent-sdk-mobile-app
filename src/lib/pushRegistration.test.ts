import { describe, expect, test } from "bun:test";
import {
  deliveryServiceUrl,
  registerForPush,
  type PushRegistrationDeps,
} from "./pushRegistration";

function deps(overrides: Partial<PushRegistrationDeps> = {}) {
  const calls: { registered?: [string, string, string] } = {};
  const base: PushRegistrationDeps = {
    hasPermission: async () => true,
    getToken: async () => "ExponentPushToken[a]",
    platform: "android",
    register: async (url, token, platform) => {
      calls.registered = [url, token, platform];
    },
    readMarker: async () => null,
    writeMarker: async () => undefined,
    log: () => undefined,
  };
  return { deps: { ...base, ...overrides }, calls };
}

describe("deliveryServiceUrl", () => {
  test("reads the build-time fleet config", () => {
    expect(deliveryServiceUrl({ EXPO_PUBLIC_DELIVERY_SERVICE_URL: "https://svc.example" })).toBe(
      "https://svc.example",
    );
    expect(deliveryServiceUrl({})).toBeNull();
    expect(deliveryServiceUrl({ EXPO_PUBLIC_DELIVERY_SERVICE_URL: "" })).toBeNull();
  });
});

describe("registerForPush", () => {
  test("registers the real Expo token with the service", async () => {
    const { deps: d, calls } = deps();
    const result = await registerForPush("https://svc.example", d);
    expect(result).toBe("registered");
    expect(calls.registered).toEqual(["https://svc.example", "ExponentPushToken[a]", "android"]);
  });

  test("no service URL is an honest no-op, not an error", async () => {
    const { deps: d, calls } = deps();
    expect(await registerForPush(null, d)).toBe("no-service");
    expect(calls.registered).toBeUndefined();
  });

  test("no permission is an honest no-op", async () => {
    const { deps: d, calls } = deps({ hasPermission: async () => false });
    expect(await registerForPush("https://svc.example", d)).toBe("no-permission");
    expect(calls.registered).toBeUndefined();
  });

  test("token failure (Expo project not provisioned) is honest quiet", async () => {
    const logs: string[] = [];
    const { deps: d, calls } = deps({
      getToken: async () => {
        throw new Error("projectId required");
      },
      log: (message) => logs.push(message),
    });
    expect(await registerForPush("https://svc.example", d)).toBe("token-failed");
    expect(logs[0]).toContain("projectId required");
    expect(calls.registered).toBeUndefined();
  });

  test("the same token does not re-register; a changed token does", async () => {
    const { deps: same } = deps({ readMarker: async () => "ExponentPushToken[a]" });
    expect(await registerForPush("https://svc.example", same)).toBe("unregistered");

    const { deps: changed, calls } = deps({ readMarker: async () => "ExponentPushToken[old]" });
    expect(await registerForPush("https://svc.example", changed)).toBe("registered");
    expect(calls.registered).toBeDefined();
  });

  test("a registration failure is logged, never thrown", async () => {
    const logs: string[] = [];
    const { deps: d } = deps({
      register: async () => {
        throw new Error("ECONNREFUSED");
      },
      log: (message) => logs.push(message),
    });
    expect(await registerForPush("https://svc.example", d)).toBe("unregistered");
    expect(logs[0]).toContain("ECONNREFUSED");
  });
});
