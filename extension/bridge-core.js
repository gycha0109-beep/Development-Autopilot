import { groupStatus, sessionStatus } from "./core.js";

export const BRIDGE_CONFIG_KEY = "autopilot.bridge.v1";
export const BRIDGE_BASE = "http://127.0.0.1:48173";

export function bridgePayload(registry, snapshot, token) {
  if (!registry || !Array.isArray(registry.sessions) || !Array.isArray(registry.groups)) {
    throw new Error("등록 정보가 없습니다.");
  }
  // Never send all Chrome tabs: only explicitly enrolled session keys.
  return {
    version: 1,
    sessions: registry.sessions.map(session => {
      const group = registry.groups.find(g => g.key === session.groupKey);
      const groupState = group && groupStatus(group, snapshot, token);
      let state = sessionStatus(session, registry, snapshot, token);
      if (state === "connected" && (session.paused || group?.paused)) state = "paused";
      if (groupState !== "connected" && state === "connected") state = "needs-rebind";
      const live = snapshot.tabs.find(t => t.id === session.tabId);
      // Only transmit the origin, not the full conversation URL (which may contain identifiers).
      let origin = "";
      try {
        if (state === "connected" || state === "paused") {
          const parsed = new URL(live?.url || session.url);
          if (["http:", "https:"].includes(parsed.protocol)) origin = parsed.origin;
        }
      } catch { /* Non-web tabs have no origin. */ }
      return {
        sessionKey: session.key, groupKey: session.groupKey,
        groupLabel: (group?.label || "").slice(0, 120),
        title: (session.title || "").slice(0, 200),
        origin,
        status: state
      };
    })
  };
}
