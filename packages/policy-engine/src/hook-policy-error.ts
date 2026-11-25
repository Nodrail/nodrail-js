import { z } from "zod";

const changedPolicy = z.object({
  error: z.object({
    code: z.enum(["RULE_CHANGED", "NOT_FOUND"]),
    message: z.string().min(1).max(1000),
  }),
});

export async function policyRefusal(response: Response) {
  if (response.status !== 409 && response.status !== 404) return undefined;
  const result = changedPolicy.safeParse(
    await response.json().catch(() => null),
  );
  return result.data?.error.message;
}
