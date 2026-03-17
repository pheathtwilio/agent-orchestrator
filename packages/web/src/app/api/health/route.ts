import { NextResponse } from "next/server";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — Returns server uptime and version
 */
export async function GET() {
  return NextResponse.json({
    uptime: process.uptime(),
    version: pkg.version,
  });
}
