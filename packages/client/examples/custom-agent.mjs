// A governed call from your own agent. Run with NODRAIL_CREDENTIAL set.
import { createNodrail } from "@nodrail/client";

const nodrail = createNodrail({ adapterVersion: "my-agent/1.0.0" });

async function closeIssue(repository, issue) {
  await nodrail.run(
    {
      tool: "github",
      operation: "issues.update",
      resource: { kind: "repository", id: repository },
      params: { issue, state: "closed" },
    },
    () => console.log("Allowed. This is where your own code calls GitHub."),
  );
}

await closeIssue("acme/support", 482).catch((error) =>
  console.log(`Blocked (${error.code})`, error.reference ?? ""),
);
