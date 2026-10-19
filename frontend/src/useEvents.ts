import { useEffect, useRef, useState } from "react";
import { API } from "./api";

export type AppEvent = { type: string; ts: number; [key: string]: any };

type Listener = (event: AppEvent) => void;
export type SseState = "connecting" | "connected" | "disconnected";

let source: EventSource | null = null;
let state: SseState = "connecting";
const listeners = new Set<Listener>();
const stateListeners = new Set<(s: SseState) => void>();

function setState(next: SseState) {
  if (state === next) return;
  state = next;
  stateListeners.forEach((fn) => fn(next));
}

function ensureConnected() {
  if (source) return;
  try {
    source = new EventSource(`${API}/api/events`);
  } catch {
    setState("disconnected");
    return;
  }
  source.onopen = () => setState("connected");
  source.onerror = () => setState("disconnected"); // EventSource auto-reconnects
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as AppEvent;
      listeners.forEach((fn) => fn(event));
    } catch {
      /* ignore malformed frames */
    }
  };
}

/** Subscribe to the raw event stream. Returns an unsubscribe function. */
export function subscribeEvents(listener: Listener): () => void {
  ensureConnected();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSseState(): SseState {
  const [current, setCurrent] = useState<SseState>(state);
  useEffect(() => {
    setCurrent(state);
    stateListeners.add(setCurrent);
    ensureConnected();
    return () => {
      stateListeners.delete(setCurrent);
    };
  }, []);
  return current;
}

/** Bounded list of recent events (newest last). */
export function useEventLog(limit = 160): AppEvent[] {
  const [events, setEvents] = useState<AppEvent[]>([]);
  useEffect(() => {
    return subscribeEvents((event) => {
      setEvents((prev) => {
        const next = prev.length >= limit ? prev.slice(prev.length - limit + 1) : prev.slice();
        next.push(event);
        return next;
      });
    });
  }, [limit]);
  return events;
}

/**
 * Callback ref for reacting to specific event types as they arrive, without
 * re-rendering. Used for TTS narration and run progress tracking.
 */
export function useEventEffect(handler: (event: AppEvent) => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    return subscribeEvents((event) => handlerRef.current(event));
  }, []);
}
