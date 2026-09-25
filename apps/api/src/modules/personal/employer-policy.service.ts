import { personalEmployerPoliciesSchema } from "@jobpilot/contracts/personal-employer-policy";
import { conflict } from "@/common/errors";
import { personalConfiguration } from "./runtime";

export async function employerPolicyLimit(
  userId: string,
  employer: string,
  userCap: number,
  configuration: typeof personalConfiguration = personalConfiguration,
): Promise<number> {
  if (!Number.isInteger(userCap) || userCap < 0 || userCap > 3)
    throw conflict("User employer application ceiling is invalid; review the user policy.");
  // A display name cannot establish which canonical employer's source policy applies.
  if (!employer.startsWith("domain:")) return userCap;
  const config = await configuration(userId);
  const parsed = personalEmployerPoliciesSchema.safeParse(
    config.employerPolicies === undefined ? [] : config.employerPolicies,
  );
  if (!parsed.success)
    throw conflict("Employer application policies are invalid; review their source evidence.");
  const policy = parsed.data.find((item) => item.canonicalEmployer === employer);
  return policy ? Math.min(userCap, policy.maxActiveApplications) : userCap;
}
