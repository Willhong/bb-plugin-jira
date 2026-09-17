import { describe, expect, it } from "vitest";
import { initials } from "../components/jira/primitives";

describe("initials", () => {
  it("uses the given name for a Korean name and first/last letters otherwise", () => {
    expect(initials("홍경택")).toBe("경택");
    expect(initials("Kim Dev Ops")).toBe("KO");
    expect(initials("admin")).toBe("AD");
    expect(initials("  ")).toBe("?");
  });
});
