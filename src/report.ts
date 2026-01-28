import type { VerifyResult, GithubIssueRef } from "./types";
import { successComment, failureComment } from "./templates";

/**
 * Parse a GitHub issue URL into owner/repo/number.
 * Accepts: https://github.com/owner/repo/issues/123
 */
export function parseIssueUrl(url: string): GithubIssueRef {
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/
  );
  if (!match) {
    throw new Error(
      `Invalid GitHub issue URL: ${url}\nExpected: https://github.com/owner/repo/issues/123`
    );
  }
  return {
    owner: match[1],
    repo: match[2],
    number: parseInt(match[3], 10),
  };
}

/**
 * Post verification result as a comment on the GitHub issue.
 * Uses `gh api` CLI (already authenticated via `gh auth login`).
 */
export async function postReport(
  issueUrl: string,
  result: VerifyResult
): Promise<void> {
  const ref = parseIssueUrl(issueUrl);
  const isSuccess = result.payment?.success ?? false;
  const body = isSuccess ? successComment(result) : failureComment(result);

  const proc = Bun.spawn(
    [
      "gh",
      "api",
      `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`,
      "-X",
      "POST",
      "-f",
      `body=${body}`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to post GitHub comment: ${stderr}`);
  }

  console.log(
    `  Posted ${isSuccess ? "success" : "failure"} comment to ${issueUrl}`
  );
}
