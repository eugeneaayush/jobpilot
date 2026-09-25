export const now = () => new Date("2026-09-16T12:00:00.000Z");
export const leverJob = (id = "job-1", region = "global") => ({
  id,
  text: "Investment Intern",
  categories: { location: "New York", allLocations: ["New York", "Boston"] },
  hostedUrl: `https://${region === "eu" ? "jobs.eu.lever.co" : "jobs.lever.co"}/example/${id}`,
  description: "<p>Research investments.</p>",
  lists: [{ text: "Requirements", content: "<li>MBA enrollment required.</li>" }],
  additional: "<p>Apply by the deadline listed separately.</p>",
  salaryDescription: "<p>Compensation disclosed at interview.</p>",
});
export const ashbyJob = (id = "job-1") => ({
  id,
  title: "Product Intern",
  location: "New York",
  secondaryLocations: [{ location: "Boston" }],
  isListed: true,
  descriptionHtml: "<p>Full MBA internship description.</p>",
  descriptionPlain: "Full MBA internship description.",
  publishedAt: "2026-09-15T12:00:00Z",
  jobUrl: `https://jobs.ashbyhq.com/example/${id}`,
});
export function jsonFetch(payloads: unknown[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const implementation = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (!payloads.length) throw new Error("Unexpected synthetic request");
    const payload = payloads.shift();
    return payload instanceof Response ? payload : Response.json(payload);
  };
  return { calls, fetch: implementation as typeof fetch };
}
