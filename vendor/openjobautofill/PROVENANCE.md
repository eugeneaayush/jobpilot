# OpenJobAutofill evaluation reference

- Upstream: https://github.com/Br1an67/OpenJobAutofill
- Inspected snapshot: `005eda98841b3671ead615ebfde5922f0dfd7c36`
- Upstream license: MIT.
- Retained upstream files or snippets: none.
- Runtime or build dependency: none.

JobPilot's changes in `plugin/scripts/personal-browser/core.ts` and
`plugin/scripts/personal-browser/greenhouse-form.ts` are independently written
against its existing driver and approval boundaries. Standard DOM labels,
`aria-label`, `aria-labelledby`, control types, unique option membership, and
post-action value readback inform field classification. No extension storage,
regional applicant defaults, extension UI, provider integration, or upstream
"filled" reporting was copied.

The regression suite uses synthetic forms. Ambiguous duplicate field identities,
conflicting preserved values, unmatched options, unverified fills/uploads, and
unknown required fields remain holds. Native multiselect and recognized
Greenhouse ReactSelect controls accept complete approved arrays of unique option
values, verify exact membership, preserve conflicting prior selections, and
require refreshed readback of the whole set. Unmatched, ambiguous, partial, or
unverifiable selections remain holds. The Greenhouse final-request audit also
requires each approved option exactly once.
