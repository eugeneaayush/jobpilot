import { createHash } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import { chromium } from "@playwright/test";
import {
  fillGreenhouseField,
  type GreenhouseField,
  inspectGreenhouseForm,
  uploadGreenhouseFile,
} from "../../../../../plugin/scripts/personal-browser/greenhouse-form";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

function combo(id: string, label: string, required = true) {
  return `<div class="select"><label id="${id}-label" for="${id}">${label}${required ? '<span aria-hidden="true">*</span>' : ""}</label><div class="select-shell"><div class="select__value-container"><input id="${id}" role="combobox" aria-labelledby="${id}-label" aria-required="${required}" aria-expanded="false" aria-controls="${id}-listbox"></div><input aria-hidden="true" tabindex="-1" required style="opacity:0"></div></div>`;
}
function upload(id: string, label: string) {
  return `<div class="file-upload" role="group" aria-required="true" aria-labelledby="upload-label-${id}"><div id="upload-label-${id}">${label}<span class="required">*</span></div><button type="button">Attach</button><label class="visually-hidden" for="${id}">Attach</label><input id="${id}" class="visually-hidden" type="file"></div>`;
}
const html = `<!doctype html><html><head><style>.visually-hidden{width:1px;height:1px;position:absolute;clip:rect(0,0,0,0)}[role=option]{padding:4px}.select-shell{width:400px}input{min-width:100px}</style></head><body>
<form id="application-form" class="application--form" method="get">
<label for="first_name">First Name<span aria-hidden="true">*</span></label><input id="first_name" aria-required="true">
<label for="last_name">Last Name*</label><input id="last_name">
<label for="email">Email</label><input id="email" aria-required="true">
${combo("country", "Country")}
<label for="phone">Phone*</label><input id="phone" type="tel">
${combo("candidate-location", "Location (City)")}
${upload("resume", "Resume/CV")}${upload("cover_letter", "Cover Letter")}
<label for="question_100">Website</label><input id="question_100">
${combo("question_101", "Preferred team")}
${combo("school_name", "School")}${combo("degree", "Degree")}${combo("end_month", "End month")}${combo("end_year", "End year")}
<button type="submit">Submit application</button></form>
<script>
const menuOptions = {
 country:[{label:'United States +1',value:'US'},{label:'United Kingdom +44',value:'GB'}],
 'candidate-location':[{label:'Synthetic City, State, United States'}],
 question_101:[{label:'Trading'},{label:'Research'}],
 school_name:[{label:'Synthetic School'}],degree:[{label:'MBA'},{label:'MS'}],
 end_month:[{label:'May',value:'5'}],end_year:[{label:'2028',value:'2028'}]
};
const delayed = new Set(['candidate-location','school_name']);
function show(input) {
 const shell=input.closest('.select-shell');
 shell.querySelector('[role=listbox]')?.remove();
 const list=document.createElement('div');list.id=input.id+'-listbox';list.setAttribute('role','listbox');
 const options=menuOptions[input.id]||JSON.parse(input.dataset.options||'[]');
 for (const item of (delayed.has(input.id)||input.dataset.dynamic==='true')&&!input.value ? [] : options) {
  const option=document.createElement('div');option.setAttribute('role','option');option.textContent=item.label;
  if(item.value!==undefined)option.setAttribute('data-value',item.value);
  option.onclick=()=>{let selected=shell.querySelector('.select__single-value');if(!selected){selected=document.createElement('div');selected.className='select__single-value';shell.prepend(selected)}selected.textContent=input.id==='country'?item.label.replace(/ \\+\\d+$/,''):item.label;input.value='';list.remove();input.setAttribute('aria-expanded','false')};
  list.append(option);
 }
 shell.append(list);input.setAttribute('aria-expanded','true');
}
for (const input of document.querySelectorAll('[role=combobox]')){
 input.onclick=()=>show(input);input.oninput=()=>show(input);input.onkeydown=event=>{if(event.key==='Escape'){input.closest('.select-shell').querySelector('[role=listbox]')?.remove();input.setAttribute('aria-expanded','false')}};
}
document.querySelector('form').onsubmit=event=>{event.preventDefault();fetch('/unexpected-submit',{method:'POST',body:'should-never-run'})};
</script></body></html>`;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const transmissions: string[] = [];
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method !== "GET" || new URL(request.url).search) transmissions.push(request.url);
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
  browser = await chromium.launch({ headless: true, timeout: 10_000 });
}, 15_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
  expect(transmissions).toEqual([]);
});
async function fixture() {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "domcontentloaded" });
  const snapshot = await inspectGreenhouseForm(page, "synthetic", {
    question_101: [
      { label: "Trading", value: "901" },
      { label: "Research", value: "902" },
    ],
    school_name: [{ label: "Synthetic School", value: "543" }],
    degree: [
      { label: "MBA", value: "12" },
      { label: "MS", value: "13" },
    ],
  });
  if (!snapshot) throw new Error("Missing synthetic Greenhouse form");
  const field = (name: string): GreenhouseField => {
    const result = snapshot.fields.find((item) => item.name === name);
    if (!result) throw new Error(`Missing synthetic field ${name}`);
    return result;
  };
  return { page, snapshot, field };
}
async function rejection(action: () => Promise<unknown>) {
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

async function compactCountry(
  page: Page,
  options: {
    selectedCode?: string;
    selectedDial?: string;
    selectedName?: string;
    duplicate?: boolean;
  } = {},
) {
  await page.locator("#country").evaluate((element, config) => {
    const input = element as HTMLInputElement;
    const shell = input.closest(".select-shell")!;
    input.onclick = () => {
      shell.querySelector('[role="listbox"]')?.remove();
      const list = document.createElement("div");
      list.id = `${input.id}-listbox`;
      list.setAttribute("role", "listbox");
      const choices = [
        { label: "United States +1", code: "us", dial: "1" },
        { label: "Canada +1", code: "ca", dial: "1" },
        { label: "United Kingdom +44", code: "gb", dial: "44" },
      ];
      if (config.duplicate) choices.push({ label: "Synthetic Country +1", code: "us", dial: "1" });
      for (const choice of choices) {
        const option = document.createElement("div");
        option.setAttribute("role", "option");
        option.innerHTML = `<div class="iti__flag iti__${choice.code}"></div>${choice.label}`;
        option.onclick = () => {
          shell.querySelector(".select__single-value")?.remove();
          const selected = document.createElement("div");
          selected.className = "select__single-value";
          const code = config.selectedCode ?? choice.code;
          const dial = config.selectedDial ?? choice.dial;
          selected.innerHTML = `${code ? `<div class="iti__flag iti__${code}"></div>` : ""}<span>${config.selectedName ?? `+${dial}`}</span>`;
          shell.prepend(selected);
          input.value = "";
          list.remove();
          input.setAttribute("aria-expanded", "false");
        };
        list.append(option);
      }
      shell.append(list);
      input.setAttribute("aria-expanded", "true");
    };
  }, options);
}

async function choiceMenu(page: Page, id: string, choices: { label: string; value?: string }[]) {
  await page.locator(`[id="${id}"]`).evaluate((element, items) => {
    const input = element as HTMLInputElement;
    const shell = input.closest(".select-shell")!;
    input.onclick = () => {
      shell.querySelector('[role="listbox"]')?.remove();
      const list = document.createElement("div");
      list.id = `${input.id}-listbox`;
      list.setAttribute("role", "listbox");
      for (const item of items) {
        const option = document.createElement("div");
        option.setAttribute("role", "option");
        option.textContent = item.label;
        if (item.value !== undefined) option.dataset.value = item.value;
        option.onclick = () => {
          shell.querySelector(".select__single-value")?.remove();
          shell.querySelector('input[type="hidden"]')?.remove();
          const selected = document.createElement("div");
          selected.className = "select__single-value";
          selected.textContent = item.label;
          shell.prepend(selected);
          if (item.value !== undefined) {
            const value = document.createElement("input");
            value.type = "hidden";
            value.name = input.id;
            value.value = item.value;
            shell.append(value);
          }
          input.value = "";
          list.remove();
          input.setAttribute("aria-expanded", "false");
        };
        list.append(option);
      }
      shell.append(list);
      input.setAttribute("aria-expanded", "true");
    };
  }, choices);
}

describe("Greenhouse hosted form adapter", () => {
  test("maps stable IDs, required labels, hidden files, and exact API choice values", async () => {
    const f = await fixture();
    try {
      expect(f.snapshot.formEvidence.rootSelector).toBe("form#application-form.application--form");
      expect(f.snapshot.fields).toHaveLength(14);
      for (const name of [
        "first_name",
        "last_name",
        "email",
        "phone",
        "country",
        "location",
        "resume",
        "cover_letter",
        "school_name",
        "degree",
        "end_month",
        "end_year",
      ])
        expect(f.field(name).required).toBe(true);
      expect(f.field("country").value).toBe("");
      expect(f.field("location")).toMatchObject({
        domId: "candidate-location",
        value: "",
        choices: [],
      });
      expect(f.field("resume")).toMatchObject({ label: "Resume/CV", type: "file", fileHashes: [] });
      expect(f.field("cover_letter").label).toBe("Cover Letter");
      expect(f.field("question_100").required).toBe(false);
      expect(f.field("question_101").choices).toEqual([
        { label: "Trading", value: "901" },
        { label: "Research", value: "902" },
      ]);
      expect(f.field("country").choices).toContainEqual({ label: "United States +1", value: "US" });
      expect(await f.page.locator('[role="combobox"][aria-expanded="true"]').count()).toBe(0);
    } finally {
      await f.page.close();
    }
  });

  test("preserves frozen text and chooses exact observed label or trusted numeric value", async () => {
    const f = await fixture();
    try {
      const value = "  Synthetic Éxample  ";
      await fillGreenhouseField(f.page, f.field("first_name"), value);
      expect(await f.page.locator("#first_name").inputValue()).toBe(value);
      await fillGreenhouseField(f.page, f.field("country"), "US");
      await fillGreenhouseField(f.page, f.field("question_101"), "902");
      await fillGreenhouseField(f.page, f.field("degree"), "12");
      expect(await selected(f.page, "country")).toBe("United States");
      expect(await selected(f.page, "question_101")).toBe("Research");
      expect(await selected(f.page, "degree")).toBe("MBA");
      expect(await f.page.locator("#candidate-location").inputValue()).toBe("");
      expect(
        (await rejection(() => fillGreenhouseField(f.page, f.field("country"), "United"))).message,
      ).toContain("unique exact");
      expect(await selected(f.page, "country")).toBe("United States");
    } finally {
      await f.page.close();
    }
  });

  test("dynamic city and school require an exact frozen answer and retain no inferred coordinates", async () => {
    const f = await fixture();
    try {
      await fillGreenhouseField(
        f.page,
        f.field("location"),
        "Synthetic City, State, United States",
      );
      await fillGreenhouseField(f.page, f.field("school_name"), "543");
      expect(await selected(f.page, "candidate-location")).toBe(
        "Synthetic City, State, United States",
      );
      expect(await selected(f.page, "school_name")).toBe("Synthetic School");
      const updated = await inspectGreenhouseForm(f.page, "updated");
      expect(updated?.fields.find((field) => field.name === "location")?.value).toBe(
        "Synthetic City, State, United States",
      );
      expect(updated?.fields.some((field) => ["latitude", "longitude"].includes(field.name))).toBe(
        false,
      );
    } finally {
      await f.page.close();
    }
  });

  test("country display shortening and phone formatting retain only observed exact digits", async () => {
    const f = await fixture();
    try {
      await fillGreenhouseField(f.page, f.field("country"), "United States +1");
      expect(await selected(f.page, "country")).toBe("United States");
      expect(
        (await rejection(() => fillGreenhouseField(f.page, f.field("country"), "United States")))
          .message,
      ).toContain("unique exact");
      await f.page.locator("#phone").evaluate((element) => {
        (element as HTMLInputElement).oninput = () => {
          (element as HTMLInputElement).value = "(212) 555-0100";
        };
      });
      await fillGreenhouseField(f.page, f.field("phone"), "2125550100");
      await fillGreenhouseField(f.page, f.field("phone"), "+12125550100", {
        phoneCountryDialCode: "1",
      });
      expect(
        (await rejection(() => fillGreenhouseField(f.page, f.field("phone"), "+12125550100")))
          .message,
      ).toContain("preserve");
      expect(
        (
          await rejection(() =>
            fillGreenhouseField(f.page, f.field("phone"), "+442125550100", {
              phoneCountryDialCode: "1",
            }),
          )
        ).message,
      ).toContain("preserve");
      expect(
        (await rejection(() => fillGreenhouseField(f.page, f.field("phone"), "2125550199")))
          .message,
      ).toContain("preserve");
    } finally {
      await f.page.close();
    }
  });

  test("retains a compact country flag and dial display only through its exact observed menu choice", async () => {
    const f = await fixture();
    try {
      await compactCountry(f.page);
      await fillGreenhouseField(f.page, f.field("country"), "United States +1");
      expect(await selected(f.page, "country")).toBe("+1");
      const updated = await inspectGreenhouseForm(f.page, "compact-country");
      expect(updated?.fields.find((field) => field.name === "country")).toMatchObject({
        value: "United States +1",
        selectedLabel: "United States +1",
      });
      expect(await f.page.locator("#phone").inputValue()).toBe("");
      expect(
        updated?.fields
          .filter((field) => field.name !== "country")
          .every((field) => field.value === ""),
      ).toBe(true);
    } finally {
      await f.page.close();
    }
  });

  for (const options of [
    { selectedCode: "ca" },
    { selectedCode: "" },
    { selectedDial: "44" },
    { duplicate: true },
  ]) {
    test(`rejects unproved compact country selection ${JSON.stringify(options)}`, async () => {
      const f = await fixture();
      try {
        await compactCountry(f.page, options);
        expect(
          (
            await rejection(() =>
              fillGreenhouseField(f.page, f.field("country"), "United States +1"),
            )
          ).message,
        ).toContain("not retained");
        expect(await f.page.locator("#phone").inputValue()).toBe("");
      } finally {
        await f.page.close();
      }
    });
  }

  test("full country name cannot conceal a contradictory observed country flag", async () => {
    const f = await fixture();
    try {
      await compactCountry(f.page, { selectedCode: "ca", selectedName: "United States" });
      expect(
        (await rejection(() => fillGreenhouseField(f.page, f.field("country"), "United States +1")))
          .message,
      ).toContain("not retained");
      await compactCountry(f.page, { selectedCode: "us", selectedName: "United States" });
      await fillGreenhouseField(f.page, f.field("country"), "United States +1");
      expect(await selected(f.page, "country")).toBe("United States");
    } finally {
      await f.page.close();
    }
  });

  test("unselected ambiguous trusted labels do not block a uniquely observed location", async () => {
    const f = await fixture();
    try {
      const chosen = "Synthetic City, State, United States";
      const ambiguous = "Synthetic Duplicate, State, United States";
      await choiceMenu(f.page, "candidate-location", [{ label: chosen }, { label: ambiguous }]);
      await fillGreenhouseField(f.page, f.field("location"), chosen);
      const snapshot = await inspectGreenhouseForm(f.page, "unique-location", {
        location: [
          { label: chosen, value: "101" },
          { label: ambiguous, value: "201" },
          { label: ambiguous, value: "202" },
        ],
      });
      const field = snapshot?.fields.find((item) => item.name === "location");
      if (!field) throw new Error("Synthetic location missing");
      expect(field.value).toBe("101");
      expect(field.choices).toEqual([{ label: chosen, value: "101" }]);
      expect(
        (await rejection(() => fillGreenhouseField(f.page, field, ambiguous))).message,
      ).toContain("Ambiguous trusted Greenhouse choice: location");
      expect(await selected(f.page, "candidate-location")).toBe(chosen);
    } finally {
      await f.page.close();
    }
  });

  test("duplicate trusted labels require an exact observed option and selected value", async () => {
    const f = await fixture();
    try {
      const choices = [
        { label: "Research", value: "901" },
        { label: "Research", value: "902" },
      ];
      await choiceMenu(f.page, "question_101", choices);
      const snapshot = await inspectGreenhouseForm(f.page, "explicit-options", {
        question_101: choices,
      });
      const field = snapshot?.fields.find((item) => item.name === "question_101");
      if (!field) throw new Error("Synthetic choice missing");
      await fillGreenhouseField(f.page, field, "902");
      const updated = await inspectGreenhouseForm(f.page, "explicit-selection", {
        question_101: choices,
      });
      expect(updated?.fields.find((item) => item.name === "question_101")?.value).toBe("902");
      await f.page
        .locator("#question_101")
        .evaluate((input) =>
          input.closest(".select-shell")?.querySelector('input[type="hidden"]')?.remove(),
        );
      expect(
        (
          await rejection(() =>
            inspectGreenhouseForm(f.page, "missing-selected-value", { question_101: choices }),
          )
        ).message,
      ).toContain("Ambiguous trusted Greenhouse choice: question_101");
    } finally {
      await f.page.close();
    }
  });

  test("repeated identical trusted pairs retain one source-grounded choice", async () => {
    const f = await fixture();
    try {
      const choices = [
        { label: "Research", value: "902" },
        { label: "Research", value: "902" },
      ];
      const snapshot = await inspectGreenhouseForm(f.page, "repeated-choice", {
        question_101: choices,
      });
      const field = snapshot?.fields.find((item) => item.name === "question_101");
      if (!field) throw new Error("Synthetic choice missing");
      await fillGreenhouseField(f.page, field, "902");
      const updated = await inspectGreenhouseForm(f.page, "repeated-selected", {
        question_101: choices,
      });
      expect(updated?.fields.find((item) => item.name === "question_101")?.value).toBe("902");
    } finally {
      await f.page.close();
    }
  });

  test("maps only the observed first education row and rejects extra rows or canonical collisions", async () => {
    const f = await fixture();
    try {
      const aliases = {
        school_name: "school--0",
        degree: "degree--0",
        end_month: "end-month--0",
        end_year: "end-year--0",
      };
      const choices = {
        school_name: [{ label: "Synthetic School", value: "543" }],
        degree: [{ label: "MBA", value: "12" }],
        end_month: [{ label: "May", value: "5" }],
        end_year: [{ label: "2028", value: "2028" }],
      };
      for (const [name, domId] of Object.entries(aliases)) {
        await f.page.locator(`[id="${name}"]`).evaluate(
          (element, data) => {
            const input = element as HTMLInputElement;
            const label = document.getElementById(`${input.id}-label`) as HTMLLabelElement;
            label.id = `${data.domId}-label`;
            label.htmlFor = data.domId;
            input.id = data.domId;
            input.setAttribute("aria-labelledby", label.id);
            input.setAttribute("aria-controls", `${data.domId}-listbox`);
            input.dataset.options = JSON.stringify(data.choices);
            if (data.domId === "school--0") input.dataset.dynamic = "true";
          },
          { domId, choices: choices[name as keyof typeof choices] },
        );
      }
      const snapshot = await inspectGreenhouseForm(f.page, "education-row", choices);
      for (const [name, domId] of Object.entries(aliases)) {
        const field = snapshot?.fields.find((item) => item.name === name);
        if (!field) throw new Error("Missing synthetic education row field");
        expect(field).toMatchObject({ domId, required: true, value: "", widget: "react_select" });
        const choice = choices[name as keyof typeof choices][0];
        await fillGreenhouseField(f.page, field, choice.value);
        expect(await selected(f.page, domId)).toBe(choice.label);
      }
      await f.page.locator("form").evaluate((form) => {
        form.insertAdjacentHTML(
          "beforeend",
          '<label for="school_name">School</label><input id="school_name">',
        );
      });
      expect(
        (await rejection(() => inspectGreenhouseForm(f.page, "duplicate-education", choices)))
          .message,
      ).toContain("Ambiguous");
      await f.page.locator('[id="school_name"]').evaluate((input) => {
        input.remove();
      });
      await f.page.locator("form").evaluate(
        (form, markup) => {
          form.insertAdjacentHTML("beforeend", markup);
        },
        combo("school--1", "School"),
      );
      expect(
        (await rejection(() => inspectGreenhouseForm(f.page, "extra-education", choices))).message,
      ).toContain("Unsupported");
    } finally {
      await f.page.close();
    }
  });

  test("discovers the source-confirmed demographic consent checkbox without inferring consent", async () => {
    const f = await fixture();
    try {
      const label =
        "By checking this box, I consent to collecting, storing, and processing my survey responses.";
      await f.page.locator("form").evaluate((form, text) => {
        const wrapper = document.createElement("div");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.id = "gdpr_demographic_data_consent_given_1";
        input.name = "gdpr_demographic_data_consent_given";
        const label = document.createElement("label");
        label.htmlFor = input.id;
        label.textContent = text;
        wrapper.append(input);
        form.append(wrapper, label);
      }, label);
      const snapshot = await inspectGreenhouseForm(f.page, "consent");
      const field = snapshot?.fields.find(
        (item) => item.name === "gdpr_demographic_data_consent_given",
      );
      if (!field) throw new Error("Missing synthetic consent control");
      expect(field).toMatchObject({
        domId: "gdpr_demographic_data_consent_given_1",
        type: "checkbox",
        required: true,
        label,
        checked: false,
      });
      expect(await f.page.locator(`[id="${field.domId}"]`).isChecked()).toBe(false);
      await fillGreenhouseField(f.page, field, false);
      expect(await f.page.locator(`[id="${field.domId}"]`).isChecked()).toBe(false);
      expect((await rejection(() => fillGreenhouseField(f.page, field, "true"))).message).toContain(
        "approved boolean",
      );
      await fillGreenhouseField(f.page, field, true);
      expect(await f.page.locator(`[id="${field.domId}"]`).isChecked()).toBe(true);
    } finally {
      await f.page.close();
    }
  });

  test("numeric demographic controls require exact loader mappings and explicit frozen choices", async () => {
    const f = await fixture();
    try {
      const ids = ["1255", "1258", "1259", "1261", "1465"];
      await f.page.locator("form").evaluate(
        (form, markup) => {
          form.insertAdjacentHTML("beforeend", markup);
          for (const input of form.querySelectorAll<HTMLInputElement>(
            '[data-demographic="true"]',
          )) {
            input.dataset.options = JSON.stringify([{ label: "I don't wish to answer" }]);
            input.onclick = () =>
              (window as unknown as { show: (input: HTMLInputElement) => void }).show(input);
            input.onkeydown = (event) => {
              if (event.key === "Escape")
                input.closest(".select-shell")?.querySelector('[role="listbox"]')?.remove();
            };
          }
        },
        ids
          .map((id) =>
            combo(id, `Synthetic demographic ${id}`, id !== "1465").replace(
              `id="${id}" role=`,
              `id="${id}" data-demographic="true" role=`,
            ),
          )
          .join(""),
      );
      expect((await rejection(() => inspectGreenhouseForm(f.page, "unmapped"))).message).toContain(
        "Unsupported",
      );
      const choices = Object.fromEntries(
        ids.map((id, index) => [
          `demographic_${id}`,
          id === "1465"
            ? []
            : [
                {
                  label: "I don't wish to answer",
                  value: ["7045", "7063", "7067", "7073"][index]!,
                },
              ],
        ]),
      );
      const snapshot = await inspectGreenhouseForm(f.page, "demographic", choices);
      for (const [id, options] of Object.entries(choices)) {
        const field = snapshot?.fields.find((item) => item.name === id);
        if (!field) throw new Error("Missing mapped synthetic demographic field");
        expect(field.value).toBe("");
        expect(field.required).toBe(id !== "demographic_1465");
        if (options[0]) {
          await fillGreenhouseField(f.page, field, options[0].value);
          expect(await selected(f.page, field.domId)).toBe("I don't wish to answer");
        }
      }
      expect(await selected(f.page, "1465")).toBeUndefined();
    } finally {
      await f.page.close();
    }
  });

  test("rejects duplicate choices, unknown numeric indexes, and stale field bindings", async () => {
    const f = await fixture();
    try {
      await f.page.evaluate(() => {
        const input = document.querySelector("#question_101");
        input?.addEventListener("click", () => {
          const list = document.querySelector("#question_101-listbox");
          if (list?.firstChild) list.append(list.firstChild.cloneNode(true));
        });
      });
      expect(
        (await rejection(() => fillGreenhouseField(f.page, f.field("question_101"), "901")))
          .message,
      ).toContain("unique exact");
      expect(
        (await rejection(() => fillGreenhouseField(f.page, f.field("country"), "0"))).message,
      ).toContain("unique exact");
      await f.page.locator("#first_name").evaluate((element) => {
        element.id = "replacement";
      });
      expect(
        (await rejection(() => fillGreenhouseField(f.page, f.field("first_name"), "Synthetic")))
          .message,
      ).toContain("changed");
    } finally {
      await f.page.close();
    }
  });

  test("uploads exact synthetic bytes to bound hidden attachment controls without submitting", async () => {
    const f = await fixture();
    try {
      const buffer = Buffer.from("%PDF-synthetic-greenhouse-canary");
      for (const name of ["resume", "cover_letter"])
        await uploadGreenhouseFile(f.page, f.field(name), {
          name: "synthetic.pdf",
          mimeType: "application/pdf",
          buffer,
        });
      expect(
        (
          await rejection(() =>
            uploadGreenhouseFile(f.page, f.field("email"), {
              name: "synthetic.pdf",
              mimeType: "application/pdf",
              buffer,
            }),
          )
        ).message,
      ).toContain("not a file");
      const updated = await inspectGreenhouseForm(f.page, "uploaded");
      const hash = createHash("sha256").update(buffer).digest("hex");
      expect(updated?.fields.find((field) => field.name === "resume")?.fileHashes).toEqual([hash]);
      expect(updated?.fields.find((field) => field.name === "cover_letter")?.fileHashes).toEqual([
        hash,
      ]);
    } finally {
      await f.page.close();
    }
  });

  test("holds unknown visible fields and does not claim an unrelated native form", async () => {
    const f = await fixture();
    try {
      await f.page.locator("form").evaluate((form) => {
        const input = document.createElement("input");
        input.id = "unverified_requirement";
        input.required = true;
        form.append(input);
      });
      expect((await rejection(() => inspectGreenhouseForm(f.page, "unknown"))).message).toContain(
        "Unsupported",
      );
      await f.page.locator("form").evaluate((form) => {
        form.id = "another-form";
      });
      expect(await inspectGreenhouseForm(f.page, "unrelated")).toBeNull();
    } finally {
      await f.page.close();
    }
  });
});

async function selected(page: Page, id: string) {
  return page
    .locator(`[id="${id}"]`)
    .evaluate(
      (input) =>
        input.closest(".select-shell")?.querySelector(".select__single-value")?.textContent,
    );
}
