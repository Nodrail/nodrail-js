import { describe, expect, test } from "vitest";
import { globCouldReachSecret, isSecretName, nameForms } from "../src/secrets.ts";

describe("secret places", () => {
  test.each([".env", ".env.staging", ".env.local", ".envrc", "id_rsa", ".git-credentials"])(
    "%s is a secret name",
    (name) => expect(isSecretName(name)).toBe(true),
  );

  test.each(["env.ts", "src", "environment.md", ".eslintrc"])("%s is not", (name) =>
    expect(isSecretName(name)).toBe(false),
  );

  test("a dot file with a suffix answers to its base", () => {
    expect(nameForms(".env.production")).toEqual([".env.production", ".env"]);
    expect(nameForms("a.b.c")).toEqual(["a.b.c"]);
  });

  test.each([".env*", "*env", "{.env,x}", ".e?v", "**/.ssh/*", "[.]env", "*/id_*"])(
    "the pattern %s could reach a secret",
    (glob) => expect(globCouldReachSecret(glob)).toBe(true),
  );

  test.each(["*.ts", "src/**/*.tsx", "{a,b}.json", "README*"])(
    "the pattern %s can't",
    (glob) => expect(globCouldReachSecret(glob)).toBe(false),
  );
});
