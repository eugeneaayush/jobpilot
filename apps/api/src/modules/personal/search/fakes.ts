import type {
  PersonalSearchBudget,
  PersonalSearchReceipt,
} from "@jobpilot/contracts/personal-search";
import type { SpendRequest, SpendReservation } from "./budget";
import type { SearchDependencies } from "./search";

export const searchNow = () => new Date("2026-09-16T12:00:00Z");
export const syntheticQuery = "Example Capital careers internships";
export const syntheticResult = (url = "https://careers.example.com/jobs/123") => ({
  url,
  title: "Example careers",
  description: "Search excerpt only.",
});
export const syntheticPage = (results: unknown[] = [], more = false, query = syntheticQuery) => ({
  type: "search",
  query: { original: query, more_results_available: more },
  web: { results },
});
export const syntheticBudget = (): PersonalSearchBudget => ({
  month: "2026-09",
  timezone: "America/New_York",
  monthlyLimitMicrousd: 200_000_000,
  searchLimitMicrousd: 50_000_000,
  monthlyReservedMicrousd: 0,
  searchReservedMicrousd: 0,
  tracking: "local_reservations",
  actualProviderBillKnown: false,
});
export function searchFixture(responses: unknown[]) {
  const reservations: SpendRequest[] = [];
  const saved: { receipt: PersonalSearchReceipt; metadata: Record<string, unknown> }[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const budget = syntheticBudget();
  const deps: SearchDependencies = {
    now: searchNow,
    configuration: async () => ({
      searchProvider: { provider: "brave", apiKey: "synthetic-key-canary" },
    }),
    reserve: async (_userId, request): Promise<SpendReservation> => {
      reservations.push(request);
      budget.monthlyReservedMicrousd += request.amountMicrousd;
      budget.searchReservedMicrousd += request.amountMicrousd;
      return { ok: true, id: crypto.randomUUID(), budget: { ...budget } };
    },
    finish: async (_userId, receipt, metadata) => {
      saved.push({ receipt, metadata });
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (!responses.length) throw new Error("Unexpected synthetic request");
      const response = responses.shift();
      return response instanceof Response ? response : Response.json(response);
    }) as typeof fetch,
  };
  return { deps, reservations, saved, calls };
}
