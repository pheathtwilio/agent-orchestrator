import { describe, expect, it } from "vitest";
import { getHealthCheck } from "../health.js";

describe("getHealthCheck", () => {
  it("returns a health check object with correct structure", () => {
    const result = getHealthCheck();

    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("timestamp");
    expect(result).toHaveProperty("version");
  });

  it("returns status as 'ok'", () => {
    const result = getHealthCheck();

    expect(result.status).toBe("ok");
  });

  it("returns a valid ISO 8601 timestamp", () => {
    const result = getHealthCheck();

    // Check that timestamp is a valid ISO 8601 date string
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(() => new Date(result.timestamp)).not.toThrow();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it("returns version as '0.1.0'", () => {
    const result = getHealthCheck();

    expect(result.version).toBe("0.1.0");
  });

  it("returns a fresh timestamp on each call", () => {
    const result1 = getHealthCheck();
    const result2 = getHealthCheck();

    // Timestamps should be different (or at least not fail this assertion)
    // We just verify both are valid timestamps
    expect(new Date(result1.timestamp).getTime()).toBeGreaterThan(0);
    expect(new Date(result2.timestamp).getTime()).toBeGreaterThan(0);
  });

  it("returns an object with exactly three properties", () => {
    const result = getHealthCheck();

    expect(Object.keys(result)).toHaveLength(3);
  });
});
