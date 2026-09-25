/**
 * Environment selector sheet — lists available computers (local backends)
 * registered with the Letta Cloud account, plus a "Cloud Sandbox" default.
 * Cloud profiles can route sessions to a specific computer or let the SDK
 * provision a managed sandbox.
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { forwardRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import type { ComputerSummary } from "../../lib/letta/api";
import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";
import { Sheet } from "../ui/Sheet";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";

interface Props {
  computers: ComputerSummary[];
  /** Currently selected connectionId, or null for cloud sandbox. */
  selectedConnectionId: string | null;
  /** Currently selected device id — leases rotate on restarts, so row
   *  selection must compare by the stable device id when one is known. */
  selectedDeviceId?: string | null;
  onSelect: (connectionId: string | null, name: string | null, deviceId?: string, asDefault?: boolean) => void;
  loading?: boolean;
  error?: string | null;
}

export const EnvironmentSheet = forwardRef<BottomSheetModal, Props>(function EnvironmentSheet(
  { computers, selectedConnectionId, selectedDeviceId, onSelect, loading, error },
  ref,
) {
  const { colors } = useTheme();
  const [dismissing, setDismissing] = useState(false);
  const [asDefault, setAsDefault] = useState(false);

  const handleSelect = (connectionId: string | null, name: string | null, deviceId?: string) => {
    setDismissing(true);
    onSelect(connectionId, name, deviceId, asDefault || undefined);
    (ref as React.RefObject<BottomSheetModal>)?.current?.dismiss();
    setDismissing(false);
  };

  // Deduplicate by deviceId — the environments API returns multiple stale
  // connection leases for the same physical device. Keep only the first
  // online entry per device. Offline entries are hidden (can't route to them).
  const seen = new Set<string>();
  const onlineComputers = computers.filter((c) => {
    if (c.status !== "online" || !c.connectionId) return false;
    if (seen.has(c.deviceId)) return false;
    seen.add(c.deviceId);
    return true;
  });

  return (
    <Sheet
      ref={ref}
      title="Environment"
      onSheetDismiss={() => {
        // Reset the default toggle every time the sheet closes — a sticky
        // checked box would silently rewrite the account-level default on
        // every later pick.
        setAsDefault(false);
        setDismissing(false);
      }}
    >
      {loading ? (
        <Text role="sub" ink={3}>
          Loading environments…
        </Text>
      ) : error ? (
        <Text role="sub" tone="danger">
          {error}
        </Text>
      ) : null}

      {/* Account-level default toggle: applies the picked environment to NEW
          conversations (existing ones keep their own choice). */}
      <Touchable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: asDefault }}
        accessibilityLabel="Use selection as default for new conversations"
        onPress={() => setAsDefault((v) => !v)}
        style={styles.defaultRow}
      >
        <View style={styles.checkboxWrap}>
          <View style={[styles.checkbox, asDefault && { borderColor: colors.accent }]}>
            {asDefault ? (
              <Text role="bodyEm" tone="accent">
                ✓
              </Text>
            ) : null}
          </View>
        </View>
        <Text role="sub" ink={2} style={styles.defaultLabel}>
          Use for new conversations
        </Text>
      </Touchable>

      {/* Cloud Sandbox (SDK default) */}
      <View style={styles.section}>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={`Cloud Sandbox${selectedConnectionId === null ? ", selected" : ""}`}
          onPress={() => handleSelect(null, null)}
          disabled={dismissing}
          style={styles.row}
        >
          <View style={styles.rowInner}>
            <View style={styles.rowText}>
              <Text role="body">Cloud Sandbox</Text>
              <Text role="sub" ink={3}>
                SDK-managed ephemeral sandbox
              </Text>
            </View>
            {selectedConnectionId === null ? (
              <Text role="bodyEm" tone="accent">
                ✓
              </Text>
            ) : null}
          </View>
        </Touchable>
      </View>

      {/* Online computers */}
      {onlineComputers.length > 0 ? (
        <View style={styles.section}>
          <Text role="micro" ink={3} style={styles.sectionLabel}>
            ONLINE
          </Text>
          {onlineComputers.map((c) => {
            // Compare by stable device id — connection leases rotate on every
            // device restart, so a stored lease matches no row after a restart.
            const selected = selectedDeviceId
              ? selectedDeviceId === c.deviceId
              : selectedConnectionId === c.connectionId;
            return (
              <Touchable
                key={c.connectionId}
                accessibilityRole="button"
                accessibilityLabel={`${c.name}${selected ? ", selected" : ""}`}
                onPress={() => handleSelect(c.connectionId, c.name, c.deviceId)}
                disabled={dismissing}
                style={styles.row}
              >
                <View style={styles.rowInner}>
                  <View style={styles.rowText}>
                    <Text role="body">{c.name}</Text>
                    <Text role="sub" ink={3} mono>
                      {c.connectionId?.slice(0, 8) ?? ""}
                    </Text>
                  </View>
                  <View style={styles.statusWrap}>
                    <View style={[styles.statusDot, { backgroundColor: "#34a853" }]} />
                    {selected ? (
                      <Text role="bodyEm" tone="accent">
                        ✓
                      </Text>
                    ) : null}
                  </View>
                </View>
              </Touchable>
            );
          })}
        </View>
      ) : null}

      {!loading && onlineComputers.length === 0 && !error ? (
        <Text role="sub" ink={3}>
          No computers online. Start the Letta Code desktop app on a device to connect it.
        </Text>
      ) : null}
    </Sheet>
  );
});

const styles = StyleSheet.create({
  section: { gap: 2 },
  sectionLabel: { paddingTop: space.xs, paddingBottom: space.xs, textTransform: "uppercase" },
  row: { minHeight: 46 },
  rowInner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6 },
  rowText: { flex: 1, gap: 1 },
  statusWrap: { flexDirection: "row", alignItems: "center", gap: space.sm },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  defaultRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm },
  checkboxWrap: { paddingVertical: 2 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#888",
    alignItems: "center",
    justifyContent: "center",
  },
  defaultLabel: { flex: 1 },
});
