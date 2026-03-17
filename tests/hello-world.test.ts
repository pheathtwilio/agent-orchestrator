import { describe, it, expect } from "vitest";

describe("Hello World", () => {
  it("should pass a basic assertion", () => {
    expect(true).toBe(true);
  });

  it("should verify string equality", () => {
    const greeting = "Hello, World!";
    expect(greeting).toBe("Hello, World!");
  });

  it("should perform basic arithmetic", () => {
    const sum = 2 + 2;
    expect(sum).toBe(4);
  });

  it("should check array contents", () => {
    const items = ["hello", "world"];
    expect(items).toHaveLength(2);
    expect(items).toContain("hello");
    expect(items).toContain("world");
  });

  it("should verify object properties", () => {
    const obj = { message: "Hello, World!", version: 1 };
    expect(obj).toHaveProperty("message");
    expect(obj.message).toBe("Hello, World!");
    expect(obj.version).toBe(1);
  });
});
