import { type Browser, chromium } from "@playwright/test";
import {
  fillGreenhouseField,
  inspectGreenhouseForm,
} from "../../../../../plugin/scripts/personal-browser/greenhouse-form";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

const base =
  '<form id="application-form" class="application--form"><label for="first_name">First Name</label><input id="first_name"><label for="last_name">Last Name</label><input id="last_name"><label for="email">Email</label><input id="email">';
const choices = [
  { value: "901", label: "Research" },
  { value: "902", label: "Trading" },
];
// Handed to Bun's `.rejects` while still pending, these fills stalled 7-10 s in Playwright, past
// the 2 s page timeout. Settling each fill before asserting avoids the stall.
const settle = (promise: Promise<unknown>) => promise.catch(() => undefined);
async function fixture(react: boolean, partial = false) {
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  await page.route("**/*", (route) => route.abort());
  const native =
    '<label for="question_42">Teams</label><select multiple id="question_42"><option value="901">Research</option><option value="902">Trading</option></select>';
  const combo =
    '<label for="question_42">Teams</label><div class="select-shell"><div class="select__value-container--is-multi"><input id="question_42" role="combobox" aria-controls="teams-list"></div></div>';
  await page.setContent(`${base}${react ? combo : native}</form>`);
  if (!react && partial)
    await page.evaluate(() => {
      const select = document.getElementById("question_42") as HTMLSelectElement;
      select.onchange = () => {
        select.options[1]!.selected = false;
      };
    });
  if (react)
    await page.evaluate(
      ({ choices }) => {
        const input = document.getElementById("question_42") as HTMLInputElement;
        const shell = input.closest(".select-shell")!;
        input.onclick = () => {
          shell.querySelector("[role=listbox]")?.remove();
          const list = document.createElement("div");
          list.id = "teams-list";
          list.setAttribute("role", "listbox");
          for (const choice of choices) {
            const option = document.createElement("div");
            option.setAttribute("role", "option");
            option.setAttribute("data-value", choice.value);
            option.textContent = choice.label;
            option.onclick = () => {
              const chip = document.createElement("div");
              chip.className = "select__multi-value__label";
              chip.textContent = choice.label;
              shell.prepend(chip);
              list.remove();
            };
            list.append(option);
          }
          shell.append(list);
        };
        input.onkeydown = (event) => {
          if (event.key === "Escape") shell.querySelector("[role=listbox]")?.remove();
        };
      },
      { choices },
    );
  const inspect = async () => {
    const snapshot = await inspectGreenhouseForm(page, "synthetic", { question_42: choices });
    return snapshot!.fields.find((field) => field.name === "question_42")!;
  };
  return { page, inspect };
}

describe("bounded Greenhouse multiselect controls", () => {
  for (const react of [false, true])
    test(`${react ? "ReactSelect" : "native"} retains the entire exact option set`, async () => {
      const f = await fixture(react);
      try {
        const field = await f.inspect();
        expect(field.multiple).toBe(true);
        expect(field.selectedValues).toEqual([]);
        await fillGreenhouseField(f.page, field, ["901", "902"]);
        expect((await f.inspect()).selectedValues?.sort()).toEqual(["901", "902"]);
      } finally {
        await f.page.close();
      }
    }, 20_000);
  test("a control that drops a selected value holds instead of claiming success", async () => {
    const f = await fixture(false, true);
    try {
      const fill = fillGreenhouseField(f.page, await f.inspect(), ["901", "902"]);
      await settle(fill);
      await expect(fill).rejects.toThrow("complete option set was not retained");
    } finally {
      await f.page.close();
    }
  }, 15_000);
  test("unknown native selections are rejected before changing a control", async () => {
    const f = await fixture(false);
    try {
      const fill = fillGreenhouseField(f.page, await f.inspect(), ["901", "999"]);
      await settle(fill);
      await expect(fill).rejects.toThrow("unique exact approved choice");
      expect((await f.inspect()).selectedValues).toEqual([]);
    } finally {
      await f.page.close();
    }
  });
});
