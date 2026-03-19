import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "@composio/ao-core";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

interface PRListItem {
  number: number;
  title: string;
  branch: string;
  author: string;
  state: "open" | "merged" | "closed";
  isDraft: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
}

async function gh(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", args, { cwd, timeout: 15_000 });
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
      return NextResponse.json({ prs: [] });
    }

    const project = config.projects[firstKey];
    const repoPath = project.path.replace(/^~/, process.env.HOME ?? "");

    // List open PRs using gh CLI
    const raw = await gh(
      [
        "pr", "list",
        "--repo", project.repo,
        "--state", "open",
        "--json", "number,title,headRefName,author,isDraft,url,createdAt,updatedAt",
        "--limit", "30",
      ],
      repoPath,
    );

    if (!raw) {
      return NextResponse.json({ prs: [] });
    }

    const items = JSON.parse(raw) as Array<{
      number: number;
      title: string;
      headRefName: string;
      author: { login: string };
      isDraft: boolean;
      url: string;
      createdAt: string;
      updatedAt: string;
    }>;

    const prs: PRListItem[] = items.map((item) => ({
      number: item.number,
      title: item.title,
      branch: item.headRefName,
      author: item.author.login,
      state: "open",
      isDraft: item.isDraft,
      url: item.url,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));

    return NextResponse.json({ prs });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list PRs" },
      { status: 500 },
    );
  }
}
