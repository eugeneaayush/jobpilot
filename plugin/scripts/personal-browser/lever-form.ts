/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import type { Field } from "./core";
import type { LeverWireField } from "./lever-network";

export interface LeverField extends Field, LeverWireField {
  widget: "native" | "radio";
}
export async function inspectLeverForm(page: Page, prefix: string) {
  return page.evaluate(async (refPrefix) => {
    const visible = (element: Element) =>
      element.getBoundingClientRect().width > 0 &&
      getComputedStyle(element).visibility !== "hidden";
    const securityBlock =
      [
        ...document.querySelectorAll(
          'input[type="password"],input[autocomplete="one-time-code"],iframe[src*="captcha"],iframe[src*="challenge"]',
        ),
      ].some(visible) ||
      !!document.querySelector('[name="g-recaptcha-response"],[name="h-captcha-response"]');
    const forms = [...document.querySelectorAll<HTMLFormElement>("form")].filter(visible);
    if (forms.length !== 1)
      return {
        securityBlock,
        fields: [],
        hidden: {},
        submitCount: 0,
        action: "",
        method: "",
        text: document.body.innerText,
        unsupported: true,
      };
    const form = forms[0]!;
    form.setAttribute("data-jobpilot-lever-form", "true");
    const hidden: Record<string, string> = {};
    const fields: LeverField[] = [];
    let unsupported = false;
    const elements = [
      ...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        "input,textarea,select",
      ),
    ].filter((input) => !input.disabled);
    const seen = new Set<string>();
    const labelFor = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) =>
      (
        [...(element.labels ?? [])].map((label) => label.textContent ?? "").join(" ") ||
        element.getAttribute("aria-label") ||
        element
          .closest(".application-question")
          ?.querySelector(".application-label,.application-question-title")?.textContent ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
    for (const [index, element] of elements.entries()) {
      if (["submit", "button", "reset"].includes(element.type)) continue;
      const name = element.name;
      if (!name || name.length > 300) {
        unsupported = true;
        continue;
      }
      if (element.type === "hidden") {
        if (
          seen.has(name) ||
          !/^(?:_csrf|csrf|csrf_token|csrfToken|authenticity_token|utf8)$/.test(name) ||
          element.value.length > 4096
        )
          unsupported = true;
        hidden[name] = element.value;
        seen.add(name);
        continue;
      }
      if (
        !visible(element) &&
        !(
          element.type === "file" &&
          visible(element.closest(".application-question") ?? element.parentElement!)
        )
      ) {
        unsupported = true;
        continue;
      }
      if (
        element.getAttribute("role") === "combobox" ||
        (element instanceof HTMLSelectElement && element.multiple)
      ) {
        unsupported = true;
        continue;
      }
      if (seen.has(name)) {
        if (element.type !== "radio") unsupported = true;
        continue;
      }
      seen.add(name);
      const ref = `${refPrefix}-${index}`;
      element.setAttribute("data-jobpilot-ref", ref);
      let label = labelFor(element);
      let required =
        element.required ||
        element.getAttribute("aria-required") === "true" ||
        label.endsWith("*") ||
        !!element.closest(".application-question.required");
      let type = element.type;
      let widget: "native" | "radio" = "native";
      let value = element.value;
      let choices: { label: string; value: string }[] = [];
      if (element instanceof HTMLSelectElement) {
        type = "select";
        choices = [...element.options]
          .filter((option) => !option.disabled)
          .map((option) => ({ label: option.label, value: option.value }));
      }
      if (element.type === "radio") {
        type = "select";
        widget = "radio";
        const radios = elements.filter(
          (input): input is HTMLInputElement =>
            input instanceof HTMLInputElement && input.name === name && input.type === "radio",
        );
        label = (
          element.closest("fieldset")?.querySelector("legend")?.textContent ||
          element
            .closest(".application-question")
            ?.querySelector(".application-label,.application-question-title")?.textContent ||
          label
        )
          .replace(/\s+/g, " ")
          .trim();
        required = required || radios.some((radio) => radio.required) || label.endsWith("*");
        choices = radios.map((radio) => {
          radio.setAttribute("data-jobpilot-lever-radio", ref);
          return { label: labelFor(radio), value: radio.value };
        });
        value = radios.find((radio) => radio.checked)?.value ?? "";
      }
      if (
        ![
          "text",
          "email",
          "tel",
          "url",
          "number",
          "date",
          "textarea",
          "select",
          "checkbox",
          "file",
        ].includes(type) ||
        !label ||
        new Set(choices.map((choice) => choice.value)).size !== choices.length
      )
        unsupported = true;
      const fileHashes =
        element instanceof HTMLInputElement && element.type === "file"
          ? await Promise.all(
              [...(element.files ?? [])].map(async (file) =>
                Array.from(
                  new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())),
                )
                  .map((byte) => byte.toString(16).padStart(2, "0"))
                  .join(""),
              ),
            )
          : undefined;
      fields.push({
        ref,
        name,
        label,
        type,
        required,
        value,
        checked: element instanceof HTMLInputElement ? element.checked : undefined,
        options: choices.map((choice) => choice.label),
        choices,
        widget,
        fileHashes,
      });
    }
    const submits = [
      ...form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        'button[type="submit"],input[type="submit"],button:not([type])',
      ),
    ].filter((button) => visible(button) && !button.disabled);
    for (const button of submits) button.setAttribute("data-jobpilot-lever-submit", "true");
    if (
      submits.some(
        (button) =>
          !!button.name ||
          !!button.getAttribute("formaction") ||
          !!button.getAttribute("formmethod"),
      )
    )
      unsupported = true;
    return {
      securityBlock,
      fields,
      hidden,
      submitCount: submits.length,
      action: form.action,
      method: form.method.toUpperCase(),
      text: document.body.innerText,
      unsupported,
    };
  }, prefix);
}
