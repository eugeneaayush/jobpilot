const countryPatterns: [string, RegExp][] = [
  ["US", /\b(?:US|USA)\b|\bU\.S\.(?:A\.?)?|\bUnited States(?: of America)?\b/],
  ["US", /\bunited states(?: of america)?\b/i],
  ["CA", /\bCanada\b|\bOntario\b|\bQuebec\b|\bBritish Columbia\b|\bToronto\b|\bVancouver\b/i],
  [
    "GB",
    /\b(?:UK|GB)\b|\bUnited Kingdom\b|\bGreat Britain\b|\bEngland\b|\bScotland\b|\bWales\b|\bLondon\b/,
  ],
  ["IE", /\bIreland\b|\bDublin\b/i],
  ["DE", /\bGermany\b|\bDeutschland\b|\bBerlin\b|\bMunich\b/i],
  ["FR", /\bFrance\b|\bParis\b/i],
  ["AU", /\bAustralia\b|\bSydney\b|\bMelbourne\b/i],
  ["NZ", /\bNew Zealand\b|\bAuckland\b/i],
  ["SG", /\bSingapore\b/i],
  ["HK", /\bHong Kong\b/i],
  ["IN", /\bIndia\b|\bMumbai\b|\bBengaluru\b|\bBangalore\b|\bHyderabad\b/i],
];
const usStates =
  /\b(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington State|West Virginia|Wisconsin|Wyoming|District of Columbia)\b/i;
const usStateCode =
  /,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\s+\d{5}(?:-\d{4})?)?(?=\s*(?:,|$))/;
const usCities =
  /\b(?:NYC|New York City|San Francisco|San Jose|Mountain View|Palo Alto|Los Angeles|San Diego|Seattle|Boston|Chicago|Houston|Dallas|Austin|Atlanta|Miami|Gainesville|Philadelphia|Washington,? DC)\b/i;

function countriesInText(text: string): Set<string> {
  return new Set(countryPatterns.filter(([, pattern]) => pattern.test(text)).map(([code]) => code));
}

function unresolvedCommaLocation(part: string): boolean {
  const pieces = part.split(",").map((piece) => piece.trim());
  if (pieces.length < 2) return false;
  return pieces.some((piece, index) => {
    if (
      countriesInText(piece).size ||
      usStates.test(piece) ||
      usCities.test(piece) ||
      usStateCode.test(`, ${piece}`)
    )
      return false;
    const following = pieces[index + 1];
    // An unlisted city with an explicit following state/country still has a jurisdiction.
    return !following || (!usStateCode.test(`, ${following}`) && !countriesInText(following).size);
  });
}

function postingJurisdiction(location: string | null): string | undefined {
  if (
    !location?.trim() ||
    /\bworldwide\b|\bglobal\b|\banywhere\b|\bEMEA\b|\bAPAC\b/i.test(location)
  )
    return undefined;
  const countries = new Set<string>();
  for (const part of location.split(/\s*(?:[;|/\n]|\band\b|\bor\b)\s*/i)) {
    if (unresolvedCommaLocation(part)) return undefined;
    const found = countriesInText(part);
    if (usStates.test(part) || usStateCode.test(part) || usCities.test(part)) found.add("US");
    // A separate unspecified location is not evidence that every placement is authorized.
    if (found.size !== 1) return undefined;
    for (const country of found) countries.add(country);
  }
  return countries.size === 1 ? [...countries][0] : undefined;
}

export function jurisdictionWorkAuthorization(
  location: string | null,
  requirement: string,
  authorized: boolean | undefined,
  explicitCountries: readonly string[],
): boolean | undefined {
  const jurisdiction = postingJurisdiction(location);
  if (!jurisdiction || authorized === undefined || !explicitCountries.includes(jurisdiction))
    return undefined;
  const requiredCountries = countriesInText(requirement);
  if (
    requiredCountries.size > 1 ||
    (requiredCountries.size === 1 && !requiredCountries.has(jurisdiction))
  )
    return undefined;
  return authorized;
}
