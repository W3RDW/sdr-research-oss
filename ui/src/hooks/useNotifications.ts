import { useEffect, useRef, useState, useCallback } from "react";
import { buildEventStreamUrl, RecordingEvent } from "../api/client";

const STORAGE_KEY = "sdr-notifications-enabled";

const EMERGENCY_TAGS = ["emergency", "mayday", "sos", "fire", "medical", "pan-pan", "911"];

function formatFreq(hz: number | null): string {
  if (!hz) return "Unknown freq";
  if (hz >= 1_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
  if (hz >= 1_000) return `${(hz / 1_000).toFixed(1)} kHz`;
  return `${hz} Hz`;
}

export function useNotifications() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    return localStorage.getItem(STORAGE_KEY) === "true";
  });

  const [permission, setPermission] = useState<NotificationPermission>(() => {
    if (typeof Notification === "undefined") return "denied";
    return Notification.permission;
  });

  const esRef = useRef<EventSource | null>(null);

  const toggle = useCallback(async () => {
    if (enabled) {
      // Turning off
      setEnabled(false);
      localStorage.setItem(STORAGE_KEY, "false");
      return;
    }

    // Turning on -- request permission if needed
    if (typeof Notification === "undefined") return;

    if (Notification.permission === "default") {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return;
    } else if (Notification.permission === "denied") {
      return;
    }

    setEnabled(true);
    localStorage.setItem(STORAGE_KEY, "true");
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      return;
    }

    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      return;
    }

    const url = buildEventStreamUrl({});
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const data: RecordingEvent = JSON.parse(e.data);

        const callsignTags = data.callsign_tags ?? [];
        const aiTags = data.ai_tags ?? [];
        const allTags = [...callsignTags, ...aiTags];

        const isEmergency = allTags.some((t) =>
          EMERGENCY_TAGS.includes(t.toLowerCase())
        );
        const hasCallsign = callsignTags.length > 0;

        if (!isEmergency && !hasCallsign) return;

        const freq = formatFreq(data.frequency_hz);
        const label = data.frequency_label ?? freq;
        const tagStr = allTags.length > 0 ? allTags.join(", ") : data.mode;

        new Notification(
          isEmergency
            ? "EMERGENCY SIGNAL DETECTED"
            : `Signal: ${callsignTags[0]}`,
          {
            body: `${label} - ${data.mode.toUpperCase()} - ${tagStr}`,
            icon: "/icon-192.png",
            tag: `recording-${data.id}`,
            requireInteraction: isEmergency,
          }
        );
      } catch {
        // Ignore parse errors from heartbeat messages etc.
      }
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [enabled]);

  return { enabled, permission, toggle };
}
