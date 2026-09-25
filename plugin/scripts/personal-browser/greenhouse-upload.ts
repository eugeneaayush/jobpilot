/// <reference lib="dom" />
import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";

const uploadUrl = "https://grnhse-prod-jben-us-east-1.s3.amazonaws.com/";
const bridges = new WeakMap<BrowserContext, string>();

export async function installGreenhouseUploadProgress(context: BrowserContext) {
  if (bridges.has(context)) return;
  const key = `__jobpilotUpload_${randomUUID().replaceAll("-", "")}`;
  bridges.set(context, key);
  try {
    await context.addInitScript(
      ({ key, uploadUrl }) => {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        const addListener = EventTarget.prototype.addEventListener;
        const dispatch = EventTarget.prototype.dispatchEvent;
        const NativeProgressEvent = ProgressEvent;
        const opened = new WeakSet<XMLHttpRequest>();
        const pending = new Map<XMLHttpRequest, object>();

        XMLHttpRequest.prototype.open = function (
          ...args: [
            method: string,
            url: string | URL,
            async?: boolean,
            username?: string | null,
            password?: string | null,
          ]
        ) {
          const [method, url, , username, password] = args;
          opened.delete(this);
          pending.delete(this);
          const result = Reflect.apply(originalOpen, this, args);
          const destination = new URL(String(url), location.href);
          if (
            method.toUpperCase() === "POST" &&
            destination.href === uploadUrl &&
            username == null &&
            password == null
          )
            opened.add(this);
          return result;
        };

        XMLHttpRequest.prototype.send = function (
          ...args: [body?: Document | XMLHttpRequestBodyInit | null]
        ) {
          let record: object | undefined;
          if (opened.has(this)) {
            opened.delete(this);
            record = {};
            pending.set(this, record);

            const remove = () => {
              if (pending.get(this) === record) pending.delete(this);
            };
            for (const event of ["abort", "error", "timeout"])
              addListener.call(this, event, remove, { once: true });
            addListener.call(
              this,
              "loadend",
              () => {
                if (
                  this.readyState !== XMLHttpRequest.DONE ||
                  this.status < 200 ||
                  this.status >= 300
                )
                  remove();
              },
              { once: true },
            );
          }
          try {
            return Reflect.apply(originalSend, this, args);
          } catch (error) {
            if (record && pending.get(this) === record) pending.delete(this);
            throw error;
          }
        };

        Object.defineProperty(window, key, {
          value: (url: string, byteLength: number) => {
            if (url !== uploadUrl || !Number.isSafeInteger(byteLength) || byteLength <= 0)
              throw new Error("Invalid Greenhouse upload progress proof");
            if (pending.size > 1) throw new Error("Ambiguous Greenhouse upload progress target");
            const xhr = pending.keys().next().value;
            if (
              !xhr ||
              xhr.readyState !== XMLHttpRequest.DONE ||
              xhr.status < 200 ||
              xhr.status >= 300
            )
              return false;
            pending.delete(xhr);
            // Route fulfillment suppresses native upload progress; the host has verified these bytes.
            dispatch.call(
              xhr.upload,
              new NativeProgressEvent("progress", {
                lengthComputable: true,
                loaded: byteLength,
                total: byteLength,
              }),
            );
            return true;
          },
        });
      },
      { key, uploadUrl },
    );
  } catch (error) {
    bridges.delete(context);
    throw error;
  }
}

export async function finishGreenhouseUploadProgress(
  page: Page,
  url: string,
  byteLength: number,
): Promise<boolean> {
  if (url !== uploadUrl || !Number.isSafeInteger(byteLength) || byteLength <= 0)
    throw new Error("Invalid Greenhouse upload progress proof");
  const key = bridges.get(page.context());
  if (!key) throw new Error("Greenhouse upload progress tracker is not installed");
  return page.evaluate(
    ({ key, url, byteLength }) => {
      const bridge = (window as unknown as Record<string, unknown>)[key];
      if (typeof bridge !== "function")
        throw new Error("Greenhouse upload progress tracker is unavailable");
      return bridge(url, byteLength) as boolean;
    },
    { key, url, byteLength },
  );
}
