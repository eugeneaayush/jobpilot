import type { PersonalRecruitingSnapshot } from "../../packages/contracts/src/personal-recruiting";

function escapeHtml(value: unknown): string {
  return String(value ?? "Unknown").replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!;
  });
}

export function renderRecruitingHtml(snapshot: PersonalRecruitingSnapshot): string {
  const { manifest } = snapshot;
  const references = (ids: string[]) =>
    ids.map((id) => `<a href="#evidence-${escapeHtml(id)}">${escapeHtml(id)}</a>`).join(", ") ||
    "No evidence recorded";
  const firms = manifest.firms
    .map((firm) => {
      const events = firm.events
        .map(
          (event) => `<article>
      <h3>${escapeHtml(event.title)}</h3>
      <p>${escapeHtml(event.timeLabel ?? event.startAt)}${event.endAt ? ` to ${escapeHtml(event.endAt)}` : ""}</p>
      <dl><dt>Registration</dt><dd>${escapeHtml(event.registrationStatus)}</dd><dt>Attendance</dt><dd>${escapeHtml(event.attendanceStatus)}</dd></dl>
      <p>${escapeHtml(event.notes)}</p><p class="evidence">${references(event.evidenceIds)}</p>
      ${event.url ? `<a href="${escapeHtml(event.url)}" rel="noopener noreferrer">Official event page</a>` : ""}
    </article>`,
        )
        .join("");
      const actions = firm.actions
        .map(
          (action) => `<li><strong>${escapeHtml(action.title)}</strong>
      <p>Due: ${escapeHtml(action.dueDate)} · Status: ${escapeHtml(action.status)}</p>
      <p>${escapeHtml(action.notes)}</p><p class="evidence">${references(action.evidenceIds)}</p></li>`,
        )
        .join("");
      return `<section><h2>${escapeHtml(firm.name)}</h2>
      <dl><dt>Application</dt><dd>${escapeHtml(firm.applicationStatus)}</dd>
      <dt>Deadline</dt><dd>${escapeHtml(firm.deadline.date)} · ${escapeHtml(firm.deadline.verification)}${firm.deadline.timeLabel ? ` · ${escapeHtml(firm.deadline.timeLabel)}` : ""}</dd></dl>
      <p class="evidence">${references(firm.deadline.evidenceIds)}</p>
      <h3>Events</h3>${events || "<p>No events recorded.</p>"}
      <h3>Next actions</h3><ol>${actions || "<li>No actions recorded.</li>"}</ol>
    </section>`;
    })
    .join("");
  const evidence = manifest.evidence
    .map(
      (item) => `<li id="evidence-${escapeHtml(item.id)}">
    <strong>${escapeHtml(item.id)}</strong> · ${escapeHtml(item.kind)} · Observed ${escapeHtml(item.observedAt)}
    <p>${escapeHtml(item.summary)}</p><p class="locator">${escapeHtml(item.locator)}</p></li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>MBB Recruiting Control Center</title><style>
body{font-family:system-ui,sans-serif;background:#f4f5f7;color:#192b3c;margin:0;line-height:1.55}main{max-width:1100px;margin:0 auto;padding:32px 24px}header,section,aside{background:white;border:1px solid #d4dce3;border-radius:12px;padding:24px;margin-bottom:20px}h1,h2,h3{line-height:1.25}h1{margin-top:0;font-size:2rem}h2{border-bottom:3px solid #0d5c72;padding-bottom:12px}article{border-left:3px solid #a5bfca;padding:2px 16px;margin:20px 0}dl{display:grid;grid-template-columns:130px 1fr;gap:8px}dt{font-weight:600}dd{margin:0}a{color:#00556c;overflow-wrap:anywhere}p,li,.locator{overflow-wrap:anywhere;white-space:pre-wrap}.evidence,.locator,footer{font-size:.85rem;color:#4b5966}li{margin:16px 0}footer{padding:0 8px}@media(max-width:600px){main{padding:14px}header,section,aside{padding:18px}dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:10px}}
</style></head><body><main><header><h1>MBB Recruiting Control Center</h1>
<p>${escapeHtml(manifest.cycle)}</p><p>${escapeHtml(manifest.objective)}</p>
<p><strong>Office priority:</strong> ${manifest.officePreferences.map(escapeHtml).join(" → ")}</p>
<p>Source updated: ${escapeHtml(manifest.updatedAt)}<br>Snapshot captured: ${escapeHtml(snapshot.capturedAt)}</p>
<p>This is a read-only local snapshot. Event registration and attendance are separate records. Availability and deadlines reflect the evidence shown, not a live portal check.</p>
</header>${firms}<aside><h2>Evidence</h2><ol>${evidence}</ol></aside>
<footer>Source SHA256: ${escapeHtml(snapshot.source.sha256)}<br>Source Git HEAD: ${escapeHtml(snapshot.source.gitHead)} · Working tree changed: ${escapeHtml(snapshot.source.gitDirty)}</footer>
</main></body></html>\n`;
}
