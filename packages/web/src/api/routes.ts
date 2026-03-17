import { NextResponse } from "next/server";
import { getHealthResponse } from "./health";

export function GET(): NextResponse {
  return NextResponse.json(getHealthResponse(), { status: 200 });
}
