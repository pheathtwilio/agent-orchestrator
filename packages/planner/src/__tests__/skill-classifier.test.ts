import { describe, it, expect } from "vitest";
import { resolveModel, modelTierToId } from "../skill-classifier.js";
import { DEFAULT_PLANNER_CONFIG } from "../types.js";

describe("resolveModel", () => {
  const policy = DEFAULT_PLANNER_CONFIG.modelPolicy;

  it("should return testing tier for testing skill", () => {
    expect(resolveModel("testing", "high", policy)).toBe("sonnet");
    expect(resolveModel("testing", "low", policy)).toBe("sonnet");
  });

  it("should return security tier for security skill", () => {
    expect(resolveModel("security", "medium", policy)).toBe("sonnet");
  });

  it("should use complexity for implementation skills", () => {
    expect(resolveModel("backend", "high", policy)).toBe("opus");
    expect(resolveModel("backend", "medium", policy)).toBe("sonnet");
    expect(resolveModel("backend", "low", policy)).toBe("haiku");
  });

  it("should work for frontend skill", () => {
    expect(resolveModel("frontend", "high", policy)).toBe("opus");
    expect(resolveModel("frontend", "medium", policy)).toBe("sonnet");
  });
});

describe("modelTierToId", () => {
  it("should map opus to claude-opus model ID", () => {
    expect(modelTierToId("opus")).toContain("opus");
  });

  it("should map sonnet to claude-sonnet model ID", () => {
    expect(modelTierToId("sonnet")).toContain("sonnet");
  });

  it("should map haiku to claude-haiku model ID", () => {
    expect(modelTierToId("haiku")).toContain("haiku");
  });
});
