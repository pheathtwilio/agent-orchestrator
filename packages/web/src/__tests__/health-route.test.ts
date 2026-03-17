import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pkg from "../../package.json";

import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  let uptimeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    uptimeSpy = vi.spyOn(process, "uptime").mockReturnValue(42.5);
  });

  afterEach(() => {
    uptimeSpy.mockRestore();
  });

  it("returns 200 with uptime and version", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.uptime).toBe(42.5);
    expect(data.version).toBe(pkg.version);
  });

  it("response includes only uptime and version keys", async () => {
    const res = await GET();
    const data = await res.json();
    expect(Object.keys(data).sort()).toEqual(["uptime", "version"]);
  });

  it("uptime is a number", async () => {
    uptimeSpy.mockReturnValue(100);
    const res = await GET();
    const data = await res.json();
    expect(typeof data.uptime).toBe("number");
  });

  it("version is a non-empty string", async () => {
    const res = await GET();
    const data = await res.json();
    expect(typeof data.version).toBe("string");
    expect(data.version.length).toBeGreaterThan(0);
  });
});
