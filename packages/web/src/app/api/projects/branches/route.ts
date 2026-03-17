import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "@composio/ao-core";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

interface BranchInfo {
  name: string;
  isCurrent: boolean;
  lastCommitAge: string;
  lastCommitMessage: string;
  isRemote: boolean;
}

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000 });
    return stdout.trimEnd();
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  try {
    const config = loadConfig();
    const firstKey = Object.keys(config.projects)[0];
    if (!firstKey) {
      return NextResponse.json({ branches: [], repoPath: "" });
    }

    const project = config.projects[firstKey];
    const repoPath = project.path.replace(/^~/, process.env.HOME ?? "");

    // Get all local branches with metadata
    const raw = await git(
      repoPath,
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)\t%(HEAD)\t%(committerdate:relative)\t%(subject)",
      "refs/heads/",
    );

    if (!raw) {
      return NextResponse.json({ branches: [], repoPath });
    }

    const branches: BranchInfo[] = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, head, age, ...msgParts] = line.split("\t");
        return {
          name: name ?? "",
          isCurrent: head === "*",
          lastCommitAge: age ?? "",
          lastCommitMessage: msgParts.join("\t").slice(0, 80),
          isRemote: false,
        };
      });

    // Get current HEAD info
    const head = await git(repoPath, "rev-parse", "--abbrev-ref", "HEAD");
    const defaultBranch = project.defaultBranch ?? "main";

    return NextResponse.json({
      branches,
      repoPath,
      currentBranch: head,
      defaultBranch,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list branches" },
      { status: 500 },
    );
  }
}
