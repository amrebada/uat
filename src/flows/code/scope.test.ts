import { describe, expect, it } from "vitest";
import { scopeDeclarations, typeOf } from "./scope";

describe("typeOf", () => {
  it("types values the way the editor should suggest them", () => {
    expect(typeOf(["x"])).toBe("string");
    expect(typeOf([null])).toBe("null");
    expect(typeOf([[]])).toBe("any[]");
    expect(typeOf([[1, "a"]])).toBe("(number | string)[]");
    expect(typeOf([{ "x-id": 1, ok: true }])).toBe('{ "x-id": number; ok: boolean }');
  });

  it("merges a list's objects, with the fields some lack optional", () => {
    const rides = [
      { id: "r-1", fare: 42, driver: { name: "Omar" } },
      { id: "r-2", fare: null },
    ];
    expect(typeOf([rides])).toBe("{ id: string; fare: number | null; driver?: { name: string } }[]");
  });

  it("stops at a depth", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 10; i++) deep = { a: deep };
    expect(typeOf([deep])).toContain("a: any");
  });
});

describe("scopeDeclarations", () => {
  it("declares each kept value, vars, log and console", () => {
    const text = scopeDeclarations(
      [
        { name: "base", source: "An input" },
        { name: "rides", source: "Kept by List rides, from body.rides" },
        { name: "later", source: "Returned by Pick" },
        { name: "x-y", source: "Kept by Odd" },
      ],
      { base: "http://localhost:8480", rides: [{ id: "r-1", status: "open" }] },
    );
    expect(text).toContain('/** An input. */\ndeclare const base: string;');
    expect(text).toContain(
      "/** Kept by List rides, from body.rides. */\ndeclare const rides: { id: string; status: string }[];",
    );
    expect(text).toContain("/** Returned by Pick. Run the flow to know its shape. */\ndeclare const later: any;");
    expect(text).not.toContain("declare const x-y");
    expect(text).toContain(
      'declare const vars: { base: string; rides: { id: string; status: string }[]; later: any; "x-y": any };',
    );
    expect(text).toContain("declare function log(...values: unknown[]): void;");
  });
});
