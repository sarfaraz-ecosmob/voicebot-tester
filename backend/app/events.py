"""In-process pub/sub event bus for the Live Monitor.

Runs publish lifecycle events (turns, extraction, LLM calls, ...) from
worker threads; the SSE endpoint (/api/events) fans them out to connected
browsers. Single-process only - fine for this local testing starter.
"""
import json
import queue
import threading
import time
from typing import Any, Iterator

_MAX_EVENT_QUEUE = 500


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[queue.Queue] = set()
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        subscriber: queue.Queue = queue.Queue(maxsize=_MAX_EVENT_QUEUE)
        with self._lock:
            self._subscribers.add(subscriber)
        return subscriber

    def unsubscribe(self, subscriber: queue.Queue) -> None:
        with self._lock:
            self._subscribers.discard(subscriber)

    def publish(self, event: dict[str, Any]) -> None:
        event = {"ts": time.time(), **event}
        with self._lock:
            subscribers = list(self._subscribers)
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(event)
            except queue.Full:
                # Slow consumer: drop rather than block the publisher.
                pass

    def sse_stream(self) -> Iterator[str]:
        """Server-Sent Events generator (iterate in a worker thread)."""
        subscriber = self.subscribe()
        try:
            yield f"data: {json.dumps({'type': 'hello', 'ts': time.time()})}\n\n"
            while True:
                try:
                    event = subscriber.get(timeout=15.0)
                    yield f"data: {json.dumps(event)}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            self.unsubscribe(subscriber)


bus = EventBus()
