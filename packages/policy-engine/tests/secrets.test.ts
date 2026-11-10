import { describe, expect, test } from "vitest";
import {
  globCouldReachSecret,
  isSecretName,
  nameForms,
  reachesSecret,
} from "../src/secrets.ts";

describe("secret places", () => {
  test.each([
    ".env",
    ".env.staging",
    ".env.local",
    ".envrc",
    "id_rsa",
    ".git-credentials",
  ])("%s is a secret name", (name) => expect(isSecretName(name)).toBe(true));

  test.each(["env.ts", "src", "environment.md", ".eslintrc"])(
    "%s is not",
    (name) => expect(isSecretName(name)).toBe(false),
  );

  test("a dot file with a suffix answers to its base", () => {
    expect(nameForms(".env.production")).toEqual([".env.production", ".env"]);
    expect(nameForms("a.b.c")).toEqual(["a.b.c"]);
  });

  test.each([
    ".env*",
    "*env",
    "{.env,x}",
    ".e?v",
    "**/.ssh/*",
    "[.]env",
    "*/id_*",
  ])("the pattern %s could reach a secret", (glob) =>
    expect(globCouldReachSecret(glob)).toBe(true),
  );

  test.each(["*.ts", "src/**/*.tsx", "{a,b}.json", "README*"])(
    "the pattern %s can't",
    (glob) => expect(globCouldReachSecret(glob)).toBe(false),
  );
});

describe("glob details", () => {
  test.each([
    ["[.]e[a-z]v", true],
    ["[!x]env", true],
    ["[^.]env", false],
    ["[.env", false],
    ["{a,{.env,b}}", true],
    [
      `{${Array.from({ length: 70 }, (_, index) => `a${index}`).join(",")}}`,
      true,
    ],
    ["x".repeat(300), true],
  ])("%s could reach a secret: %s", (glob, expected) => {
    expect(globCouldReachSecret(glob)).toBe(expected);
  });
});

describe("reachesSecret", () => {
  test.each([
    [{ reaches_secrets: true }, true],
    [{ path_parts: ["src", ".env"] }, true],
    [{ path_parts: ["home", ".config", "gh", "hosts.yml"] }, true],
    [{ path_parts: ["home", ".config", "nvim"] }, false],
    [{ path_parts: "not a list" }, false],
    [{ path_parts: [1, null, "src"] }, false],
    [{}, false],
  ])("%j: %s", (params, expected) => {
    expect(reachesSecret(params)).toBe(expected);
  });
});
