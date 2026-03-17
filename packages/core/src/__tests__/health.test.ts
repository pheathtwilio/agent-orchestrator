import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getHealthCheck } from "../health.js";

describe("getHealthCheck", () => {
  let originalDateNow: () => number;

  beforeEach(() => {
    originalDateNow = Date.now;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  it("returns status 'ok'", () => {
    const result = getHealthCheck();
    expect(result.status).toBe("ok");
  });

  it("returns version '0.1.0'", () => {
    const result = getHealthCheck();
    expect(result.version).toBe("0.1.0");
  });

  it("returns a valid ISO 8601 timestamp", () => {
    const result = getHealthCheck();
    expect(result.timestamp).toBeDefined();

    // Should be a valid ISO 8601 date string
    const date = new Date(result.timestamp);
    expect(date.toISOString()).toBe(result.timestamp);
  });

  it("returns current timestamp", () => {
    const now = new Date("2026-03-17T12:00:00.000Z");
    vi.setSystemTime(now);

    const result = getHealthCheck();
    expect(result.timestamp).toBe("2026-03-17T12:00:00.000Z");

    vi.useRealTimers();
  });

  it("returns all required fields", () => {
    const result = getHealthCheck();

    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("timestamp");
    expect(result).toHaveProperty("version");
  });

  it("returns consistent structure across multiple calls", () => {
    const result1 = getHealthCheck();
    const result2 = getHealthCheck();

    expect(typeof result1.status).toBe("string");
    expect(typeof result1.timestamp).toBe("string");
    expect(typeof result1.version).toBe("string");

    expect(typeof result2.status).toBe("string");
    expect(typeof result2.timestamp).toBe("string");
    expect(typeof result2.version).toBe("string");
  });

  it("returns different timestamps on sequential calls", () => {
    const result1 = getHealthCheck();

    // Small delay to ensure different timestamps
    const start = Date.now();
    while (Date.now() === start) {
      // Busy wait for at least 1ms
    }

    const result2 = getHealthCheck();

    // Status and version should be the same
    expect(result1.status).toBe(result2.status);
    expect(result1.version).toBe(result2.version);

    // Timestamps should be different (unless called in same millisecond, which we avoided)
    expect(result1.timestamp).not.toBe(result2.timestamp);
  });

  it("matches the expected response type structure", () => {
    const result = getHealthCheck();

    // Type check: ensure only expected properties exist
    const keys = Object.keys(result);
    expect(keys).toHaveLength(3);
    expect(keys).toContain("status");
    expect(keys).toContain("timestamp");
    expect(keys).toContain("version");
  });
});
