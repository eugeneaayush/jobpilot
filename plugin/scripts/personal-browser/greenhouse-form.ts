/// <reference lib="dom" />
import type { Page } from "@playwright/test";

export interface GreenhouseField {
  ref: string;
  name: string;
  label: string;
  type: string;
  required: boolean;
  value: string;
  checked?: boolean;
  fileHashes?: string[];
  options: string[];
  adapter: "greenhouse";
  domId: string;
  widget: "native" | "react_select";
  choices: { label: string; value: string }[];
  trustedChoices?: readonly { label: string; value: string }[];
  selectedLabel?: string;
}

const rootSelector = "form#application-form.application--form";

function uniqueTrustedChoices(choices: GreenhouseField["trustedChoices"] = []) {
  return [
    ...new Map(
      choices.map((choice) => [JSON.stringify([choice.label, choice.value]), choice]),
    ).values(),
  ];
}

function trustedChoice(field: GreenhouseField, label: string | undefined, explicitValue?: string) {
  const matches = uniqueTrustedChoices(field.trustedChoices).filter(
    (choice) => choice.label === label,
  );
  if (explicitValue !== undefined && matches.length) {
    const choice = matches.find((item) => item.value === explicitValue);
    if (!choice)
      throw new Error(`Greenhouse choice differs from its trusted inventory: ${field.name}`);
    return { choice, ambiguous: false };
  }
  return { choice: matches.length === 1 ? matches[0] : undefined, ambiguous: matches.length > 1 };
}

async function boundField(page: Page, field: GreenhouseField) {
  if (!/^[a-zA-Z0-9-]+$/.test(field.ref)) throw new Error("Invalid Greenhouse field reference");
  const control = page.locator(`${rootSelector} [data-jobpilot-ref="${field.ref}"]`);
  if ((await control.count()) !== 1 || (await control.getAttribute("id")) !== field.domId)
    throw new Error("Greenhouse field changed; inspect again");
  return control;
}

async function observedChoices(page: Page, field: GreenhouseField) {
  const choices = await page.evaluate((ref) => {
    const input = document.querySelector(`[data-jobpilot-ref="${ref}"]`);
    if (!input) throw new Error("Greenhouse field changed; inspect again");
    const listId = input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
    const list = listId
      ? document.getElementById(listId)
      : input.closest(".select-shell")?.querySelector('[role="listbox"]');
    if (!list) return [];
    return [...list.querySelectorAll<HTMLElement>('[role="option"]')]
      .filter((option) => option.getBoundingClientRect().width > 0)
      .map((option, index) => {
        const label = (option.getAttribute("aria-label") || option.textContent || "").trim();
        // React Select option IDs are indexes, never public API values.
        const explicitValue = option.getAttribute("data-value") ?? option.getAttribute("value");
        const value = explicitValue ?? label;
        const flags = option.querySelectorAll(".iti__flag");
        const codes = [...(flags.length === 1 ? flags[0]!.classList : [])].filter((name) =>
          /^iti__[a-z]{2}$/.test(name),
        );
        const optionRef = `${ref}-option-${index}`;
        option.setAttribute("data-jobpilot-option", optionRef);
        return {
          label,
          value,
          explicitValue,
          optionRef,
          countryCode:
            input.id === "country" && codes.length === 1 ? codes[0]!.slice(5) : undefined,
          disabled: option.getAttribute("aria-disabled") === "true",
        };
      });
  }, field.ref);
  return choices.map((choice) => {
    const mapped = trustedChoice(field, choice.label, choice.explicitValue ?? undefined);
    return { ...choice, value: mapped.choice?.value ?? choice.value, ambiguous: mapped.ambiguous };
  });
}

async function observedSelection(page: Page, field: GreenhouseField) {
  return (await boundField(page, field)).evaluate((input) => {
    const shell = input.closest(".select-shell");
    const selected = shell?.querySelector(".select__single-value");
    const flags = selected?.querySelectorAll(".iti__flag");
    const codes = [...(flags?.length === 1 ? flags[0]!.classList : [])].filter((name) =>
      /^iti__[a-z]{2}$/.test(name),
    );
    return {
      label: selected?.textContent?.trim(),
      value: shell?.querySelector<HTMLInputElement>('input[type="hidden"][name]')?.value,
      countryCode: codes.length === 1 ? codes[0]!.slice(5) : undefined,
    };
  });
}

function compactCountryChoice<T extends { label: string; countryCode?: string }>(
  selected: { label?: string; countryCode?: string },
  choices: readonly T[],
) {
  if (!selected.countryCode || !/^\+[1-9][0-9]{0,3}$/.test(selected.label ?? "")) return;
  // Several countries share a dial code; the observed flag must identify one option.
  const matches = choices.filter(
    (choice) =>
      choice.countryCode === selected.countryCode && choice.label.endsWith(` ${selected.label}`),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export async function inspectGreenhouseForm(
  page: Page,
  refPrefix: string,
  trustedChoicesByName: Record<string, readonly { label: string; value: string }[]> = {},
) {
  if (!/^[a-zA-Z0-9-]+$/.test(refPrefix)) throw new Error("Invalid Greenhouse snapshot reference");
  const roots = page.locator(rootSelector);
  if ((await roots.count()) === 0) return null;
  if ((await roots.count()) !== 1) throw new Error("Ambiguous Greenhouse application form");
  const fields: GreenhouseField[] = await page.evaluate(
    async ({ selector, prefix, demographicIds }) => {
      const root = document.querySelector(selector);
      if (!root) throw new Error("Greenhouse application form changed");
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        return (
          element.getBoundingClientRect().width > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };
      const controls = [
        ...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
          "input,textarea,select",
        ),
      ].filter((element) => {
        if (
          element.disabled ||
          element.type === "hidden" ||
          element.getAttribute("aria-hidden") === "true"
        )
          return false;
        if (element instanceof HTMLInputElement && element.type === "file") {
          const group = element.closest('.file-upload[role="group"]');
          if (!group) throw new Error("Unsupported Greenhouse attachment control");
          return visible(group);
        }
        return visible(element);
      });
      const ids = new Set<string>();
      const names = new Set<string>();
      const educationIds: Record<string, string> = {
        "school--0": "school_name",
        "degree--0": "degree",
        "end-month--0": "end_month",
        "end-year--0": "end_year",
      };
      return Promise.all(
        controls.map(async (element, index) => {
          const domId = element.id;
          const demographic = demographicIds.includes(domId);
          const education = Object.hasOwn(educationIds, domId) ? educationIds[domId] : undefined;
          const consent = domId === "gdpr_demographic_data_consent_given_1";
          if (
            (!demographic &&
              !education &&
              !consent &&
              !/^(?:first_name|last_name|email|phone|country|candidate-location|resume|cover_letter|resume_text|cover_letter_text|school_name|degree|discipline|start_month|start_year|end_month|end_year|question_\d+)$/.test(
                domId,
              )) ||
            ids.has(domId)
          )
            throw new Error("Unsupported or ambiguous Greenhouse field");
          ids.add(domId);
          let name = domId === "candidate-location" ? "location" : domId;
          if (demographic) name = `demographic_${domId}`;
          if (education) name = education;
          if (consent) {
            name = "gdpr_demographic_data_consent_given";
            if (element.name !== name || element.type !== "checkbox")
              throw new Error("Unsupported Greenhouse consent control");
          }
          if (names.has(name)) throw new Error("Ambiguous Greenhouse field identity");
          names.add(name);
          const isFile = element instanceof HTMLInputElement && element.type === "file";
          const group = isFile ? element.closest('.file-upload[role="group"]') : null;
          const labelIds = (
            group?.getAttribute("aria-labelledby") ||
            element.getAttribute("aria-labelledby") ||
            ""
          )
            .split(/\s+/)
            .filter(Boolean);
          const label = (
            labelIds.map((id) => document.getElementById(id)?.textContent || "").join(" ") ||
            [...(element.labels ?? [])].map((node) => node.textContent || "").join(" ") ||
            element.getAttribute("aria-label") ||
            ""
          ).trim();
          if (!label) throw new Error("Greenhouse field has no observed label");
          const widget = element.getAttribute("role") === "combobox" ? "react_select" : "native";
          const shell = widget === "react_select" ? element.closest(".select-shell") : null;
          if (widget === "react_select" && !shell)
            throw new Error("Unsupported Greenhouse select control");
          const selected = shell?.querySelector(".select__single-value");
          const selectedLabel = selected?.textContent?.trim();
          const selectedInput = shell?.querySelector<HTMLInputElement>(
            'input[type="hidden"][name]',
          );
          let type = element.type;
          if (element instanceof HTMLTextAreaElement) type = "textarea";
          if (element instanceof HTMLSelectElement || widget === "react_select") type = "select";
          const choices =
            element instanceof HTMLSelectElement
              ? [...element.options]
                  .filter((option) => !option.disabled)
                  .map((option) => ({ label: option.label, value: option.value }))
              : [];
          let value = element.value;
          if (widget === "react_select") value = selectedInput?.value || selectedLabel || "";
          const fileHashes = isFile
            ? await Promise.all(
                Array.from(element.files ?? []).map(async (file) => {
                  if (file.size > 20_000_000) throw new Error("Observed file exceeds limit");
                  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
                  return Array.from(new Uint8Array(digest), (byte) =>
                    byte.toString(16).padStart(2, "0"),
                  ).join("");
                }),
              )
            : undefined;
          const ref = `${prefix}-${index}`;
          element.setAttribute("data-jobpilot-ref", ref);
          return {
            ref,
            name,
            label: label.replace(/\s*\*\s*$/, "").trim(),
            type,
            required:
              consent ||
              element.required ||
              element.getAttribute("aria-required") === "true" ||
              group?.getAttribute("aria-required") === "true" ||
              /\*/.test(label),
            value,
            checked: element instanceof HTMLInputElement ? element.checked : undefined,
            fileHashes,
            options: choices.flatMap((choice) => [choice.value, choice.label]),
            adapter: "greenhouse" as const,
            domId,
            widget,
            choices,
            selectedLabel,
          };
        }),
      );
    },
    {
      selector: rootSelector,
      prefix: refPrefix,
      demographicIds: Object.keys(trustedChoicesByName)
        .filter((name) => /^demographic_\d+$/.test(name))
        .map((name) => name.slice("demographic_".length)),
    },
  );
  if (
    !["first_name", "last_name", "email"].every((name) =>
      fields.some((field) => field.name === name),
    )
  )
    throw new Error("Incomplete Greenhouse application form evidence");
  for (const field of fields) {
    field.trustedChoices = uniqueTrustedChoices(trustedChoicesByName[field.name]);
    const selected = trustedChoice(
      field,
      field.selectedLabel,
      field.value !== field.selectedLabel ? field.value : undefined,
    );
    if (selected.ambiguous) throw new Error(`Ambiguous trusted Greenhouse choice: ${field.name}`);
    if (selected.choice) field.value = selected.choice.value;
  }
  for (const field of fields.filter((item) => item.widget === "react_select")) {
    const control = await boundField(page, field);
    await control.click();
    try {
      const choices = (await observedChoices(page, field)).filter(
        (choice) => !choice.disabled && !choice.ambiguous,
      );
      field.choices = choices.map(({ label, value }) => ({ label, value }));
      field.options = field.choices.flatMap((choice) => [choice.value, choice.label]);
      if (field.domId === "country") {
        const selected = await observedSelection(page, field);
        if (/^\+[1-9][0-9]{0,3}$/.test(selected.label ?? "")) {
          const choice = compactCountryChoice(selected, choices);
          if (!choice)
            throw new Error("Greenhouse country selection has no unique observed choice");
          field.value = choice.value;
          field.selectedLabel = choice.label;
        }
      }
    } finally {
      await control.press("Escape");
    }
  }
  return { fields, formEvidence: { rootSelector, stableIds: fields.map((field) => field.domId) } };
}

export async function fillGreenhouseField(
  page: Page,
  field: GreenhouseField,
  frozenValue: string | boolean,
  context: { phoneCountryDialCode?: string } = {},
) {
  const control = await boundField(page, field);
  if (field.widget === "react_select") {
    if (typeof frozenValue !== "string" || !frozenValue)
      throw new Error("Greenhouse select requires an exact approved choice");
    await control.click();
    try {
      let choices = await observedChoices(page, field);
      if (
        !choices.some((choice) => choice.label === frozenValue || choice.value === frozenValue) &&
        [
          "location",
          "school_name",
          "degree",
          "discipline",
          "start_month",
          "start_year",
          "end_month",
          "end_year",
        ].includes(field.name)
      ) {
        const mapped = uniqueTrustedChoices(field.trustedChoices).filter(
          (choice) => choice.value === frozenValue,
        );
        if (mapped.length > 1)
          throw new Error(`Ambiguous trusted Greenhouse choice: ${field.name}`);
        await control.fill(mapped[0]?.label ?? frozenValue);
        await page
          .waitForFunction(
            ({ ref, label, value }) => {
              const input = document.querySelector(`[data-jobpilot-ref="${ref}"]`);
              const id = input?.getAttribute("aria-controls") || input?.getAttribute("aria-owns");
              return (
                !!id &&
                [...(document.getElementById(id)?.querySelectorAll('[role="option"]') ?? [])].some(
                  (option) =>
                    (option.getAttribute("aria-label") || option.textContent || "").trim() ===
                      label ||
                    option.getAttribute("data-value") === value ||
                    option.getAttribute("value") === value,
                )
              );
            },
            { ref: field.ref, label: mapped[0]?.label ?? frozenValue, value: frozenValue },
            { timeout: 3_000 },
          )
          .catch(() => undefined);
        choices = await observedChoices(page, field);
      }
      if (
        choices.some(
          (choice) =>
            choice.ambiguous &&
            (choice.label === frozenValue ||
              field.trustedChoices?.some(
                (item) => item.label === choice.label && item.value === frozenValue,
              )),
        )
      )
        throw new Error(`Ambiguous trusted Greenhouse choice: ${field.name}`);
      const matches = choices.filter(
        (choice) =>
          !choice.ambiguous && (choice.label === frozenValue || choice.value === frozenValue),
      );
      if (matches.length !== 1 || !matches[0] || matches[0].disabled)
        throw new Error("Greenhouse select has no unique exact approved choice");
      await page.locator(`[data-jobpilot-option="${matches[0].optionRef}"]`).click();
      const selected = await observedSelection(page, field);
      if (
        field.domId === "country" &&
        selected.countryCode &&
        matches[0].countryCode &&
        selected.countryCode !== matches[0].countryCode
      )
        throw new Error("Greenhouse choice was not retained: country");
      const countryLabel =
        field.domId === "country"
          ? /^(.*) \+([1-9][0-9]{0,3})$/.exec(matches[0].label)?.[1]
          : undefined;
      const compactCountry =
        field.domId === "country"
          ? compactCountryChoice(
              selected,
              choices.filter((choice) => !choice.disabled),
            )
          : undefined;
      if (
        selected.label !== matches[0].label &&
        selected.value !== matches[0].value &&
        (!countryLabel || selected.label !== countryLabel) &&
        compactCountry?.optionRef !== matches[0].optionRef
      )
        throw new Error("Greenhouse choice was not retained");
    } finally {
      await control.press("Escape");
    }
    return;
  }
  if (field.type === "checkbox") {
    if (typeof frozenValue !== "boolean")
      throw new Error("Greenhouse checkbox requires an approved boolean");
    await control.setChecked(frozenValue);
    return;
  }
  if (typeof frozenValue !== "string")
    throw new Error("Greenhouse text field requires an approved string");
  if (field.type === "select") {
    const matches = field.choices.filter(
      (choice) => choice.label === frozenValue || choice.value === frozenValue,
    );
    if (matches.length !== 1 || !matches[0])
      throw new Error("Greenhouse select has no unique exact approved choice");
    await control.selectOption(matches[0].value);
    return;
  }
  if (!["text", "email", "tel", "url", "number", "textarea"].includes(field.type))
    throw new Error("Unsupported Greenhouse fill control");
  await control.fill(frozenValue);
  const observed = await control.inputValue();
  if (
    field.domId === "phone" &&
    /^[+0-9().\- ]+$/.test(frozenValue) &&
    /^[+0-9().\- ]+$/.test(observed)
  ) {
    const approvedDigits = frozenValue.replace(/\D/g, "");
    const observedDigits = observed.replace(/\D/g, "");
    if (approvedDigits === observedDigits) return;
    if (
      context.phoneCountryDialCode &&
      /^[1-9][0-9]{0,3}$/.test(context.phoneCountryDialCode) &&
      frozenValue.startsWith("+") &&
      approvedDigits === context.phoneCountryDialCode + observedDigits
    )
      return;
  }
  if (observed !== frozenValue)
    throw new Error("Greenhouse field did not preserve the approved value");
}

export async function uploadGreenhouseFile(
  page: Page,
  field: GreenhouseField,
  payload: { name: string; mimeType: string; buffer: Buffer },
) {
  const control = await boundField(page, field);
  if (field.type !== "file" || (await control.getAttribute("type")) !== "file")
    throw new Error("Greenhouse attachment target is not a file control");
  await control.setInputFiles(payload);
}
