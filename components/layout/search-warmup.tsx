"use client";

import { useEffect } from "react";

interface IdleDeadlineLike {
  didTimeout: boolean;
  timeRemaining: () => number;
}

export function SearchWarmup() {
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (
        callback: (deadline: IdleDeadlineLike) => void,
        options?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const warm = () => {
      void fetch("/api/search?query=~").catch(() => {
        // Ignore failures; this call is just a best-effort warmup.
      });
    };

    if (typeof w.requestIdleCallback === "function") {
      const handle = w.requestIdleCallback(() => warm(), { timeout: 2000 });
      return () => {
        if (typeof w.cancelIdleCallback === "function") {
          w.cancelIdleCallback(handle);
        }
      };
    }

    const timeout = window.setTimeout(warm, 1000);
    return () => window.clearTimeout(timeout);
  }, []);

  return null;
}
