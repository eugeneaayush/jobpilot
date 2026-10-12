import type { Cookie } from "elysia";
import { oauthStateCookies } from "./oauth-state";
import { describe, expect, it } from "bun:test";

const NAMES = { state: "oauth_state", companion: "oauth_intent" } as const;
const PATH = "/api/auth/oauth";

function makeJar() {
  const entries: Record<string, { value?: string; setOpts?: Record<string, unknown> }> = {};
  const cookie = (name: string): Cookie<unknown> =>
    ({
      get value() {
        return entries[name]?.value;
      },
      set(opts: Record<string, unknown>) {
        entries[name] = { value: opts.value as string | undefined, setOpts: opts };
      },
    }) as unknown as Cookie<unknown>;
  const jar: Record<string, Cookie<unknown>> = {
    [NAMES.state]: cookie(NAMES.state),
    [NAMES.companion]: cookie(NAMES.companion),
  };
  return { jar, entries };
}

describe("oauthStateCookies", () => {
  it("sets and reads back both values", () => {
    const { jar } = makeJar();
    const cookies = oauthStateCookies(jar, NAMES, PATH);

    cookies.set("state-nonce", "signin");

    expect(cookies.state()).toBe("state-nonce");
    expect(cookies.companion()).toBe("signin");
  });

  it("marks the pair httpOnly, lax, path-scoped and short-lived", () => {
    const { jar, entries } = makeJar();
    oauthStateCookies(jar, NAMES, PATH).set("s", "c");

    // secure is false because bun test runs with NODE_ENV=test, not production.
    expect(entries[NAMES.state]?.setOpts).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: PATH,
      maxAge: 600,
    });
    expect(entries[NAMES.companion]?.setOpts).toMatchObject({ path: PATH, maxAge: 600 });
  });

  it("clear() empties both cookies so state() reads them as absent", () => {
    const { jar, entries } = makeJar();
    const cookies = oauthStateCookies(jar, NAMES, PATH);
    cookies.set("s", "c");

    cookies.clear();

    expect(entries[NAMES.state]?.setOpts).toMatchObject({ value: "", path: PATH, maxAge: 0 });
    expect(cookies.state()).toBeUndefined();
    expect(cookies.companion()).toBeUndefined();
  });

  it("treats a never-set cookie as absent", () => {
    const { jar } = makeJar();
    const cookies = oauthStateCookies(jar, NAMES, PATH);

    expect(cookies.state()).toBeUndefined();
    expect(cookies.companion()).toBeUndefined();
  });
});
