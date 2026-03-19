import { NextResponse } from "next/server";
import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";

export const dynamic = "force-dynamic";

const BRAINSTORM_SKILLS_DIR = join(process.cwd(), "../../docker/skills/brainstorm");

function titleCase(str: string): string {
  return str
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function GET(): Promise<Response> {
  const agents: Array<{ id: string; name: string; description?: string }> = [
    { id: "default", name: "Default Brainstorm Agent" },
  ];

  try {
    const files = await readdir(BRAINSTORM_SKILLS_DIR);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const id = basename(file, ".md");
      const content = await readFile(join(BRAINSTORM_SKILLS_DIR, file), "utf-8");
      const firstLine = content.split("\n")[0]?.replace(/^#+\s*/, "").trim();
      agents.push({
        id,
        name: titleCase(id),
        description: firstLine || undefined,
      });
    }
  } catch {
    // Directory may not exist — return just the default
  }

  return NextResponse.json({ agents });
}
