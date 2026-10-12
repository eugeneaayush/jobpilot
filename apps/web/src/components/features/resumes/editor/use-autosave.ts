"use client";

import { useEffect, useRef, useState } from "react";

/** Long enough to swallow a burst of typing, short enough that leaving the page feels safe. */
const DEBOUNCE_MS = 1500;

export type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

interface AutosaveOptions<T> {
  save: (value: T) => Promise<unknown>;
}

interface Autosave<T> {
  state: SaveState;
  change: (value: T) => void;
  flush: () => void;
}

/** Pending value lives in a ref, so the timer writes the newest edit without re-arming. */
export function useAutosave<T>(options: AutosaveOptions<T>): Autosave<T> {
  const { save } = options;
  const [state, setState] = useState<SaveState>("clean");
  const pending = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  const write = (): void => {
    const value = pending.current;
    if (value === null) {
      return;
    }
    pending.current = null;
    setState("saving");
    saveRef.current(value).then(
      () => setState((current) => (current === "saving" ? "saved" : current)),
      () => setState("error"),
    );
  };

  const clearTimer = (): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const flush = (): void => {
    clearTimer();
    write();
  };

  const change = (value: T): void => {
    pending.current = value;
    setState("dirty");
    clearTimer();
    timer.current = setTimeout(flush, DEBOUNCE_MS);
  };

  // Navigating away mid-debounce would otherwise drop the last edit.
  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        if (pending.current !== null) {
          // Unmounted, so there is no "error" state left to set; the save reports its own failure.
          saveRef.current(pending.current).catch(() => null);
        }
      }
    };
  }, []);

  return { state, change, flush };
}
