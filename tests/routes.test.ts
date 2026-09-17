import { describe, expect, it } from "vitest";
import { parseSubPath, routeToSubPath } from "../routes";

describe("panel routes", () => {
  it("round-trips an open issue", () => {
    expect(routeToSubPath({ issueKey: "WEB-12" })).toBe("issue/WEB-12");
    expect(parseSubPath("issue/WEB-12")).toEqual({ issueKey: "WEB-12" });
    expect(parseSubPath("issue/web-12")).toEqual({ issueKey: "WEB-12" });
  });

  it("falls back to the list for anything else", () => {
    expect(parseSubPath("")).toEqual({ issueKey: null });
    expect(parseSubPath("issue")).toEqual({ issueKey: null });
    expect(parseSubPath("issue/not a key")).toEqual({ issueKey: null });
    expect(parseSubPath("issue/WEB-1/extra")).toEqual({ issueKey: null });
    expect(routeToSubPath({ issueKey: null })).toBe("");
  });
});
