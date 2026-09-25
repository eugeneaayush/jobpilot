export function personalModeEnabled(): boolean {
  return process.env.PERSONAL_MODE === "true";
}

export function isPrivateOnlyRoute(pathname: string): boolean {
  return /^\/api\/public(?:\/|$)/.test(pathname) || /^\/api\/promotions?(?:\/|$)/.test(pathname);
}
