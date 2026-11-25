const account = "test-windows-user:";

export function fakeDpapi(
  _file: string,
  args: string[],
  { input }: { input: string },
) {
  const script = args.at(-1) ?? "";
  if (script.includes("::Protect("))
    return Buffer.from(account + input).toString("base64");
  const data = Buffer.from(input, "base64").toString();
  if (script.includes("::Unprotect(") && data.startsWith(account))
    return data.slice(account.length);
  throw new Error("different Windows user");
}
