import { describe, expect, it } from "vite-plus/test";

import { isBlockedFrameViolation } from "./BrowserDocumentFrame";

const src = "https://environment.test/api/assets/thread/page.html?signature=abc";

describe("isBlockedFrameViolation", () => {
  it("matches a refused frame reported with its full URL", () => {
    expect(isBlockedFrameViolation(src, { directive: "frame-src", blockedURI: src })).toBe(true);
  });

  it("matches a refused frame reported as a bare origin", () => {
    expect(
      isBlockedFrameViolation(src, {
        directive: "frame-src",
        blockedURI: "https://environment.test",
      }),
    ).toBe(true);
  });

  it("matches the legacy directive name browsers still report", () => {
    expect(isBlockedFrameViolation(src, { directive: "child-src 'self'", blockedURI: src })).toBe(
      true,
    );
  });

  it("ignores a frame served by another environment", () => {
    expect(
      isBlockedFrameViolation(src, {
        directive: "frame-src",
        blockedURI: "https://other.test/page.html",
      }),
    ).toBe(false);
  });

  it("ignores violations of other directives and unparseable reports", () => {
    expect(isBlockedFrameViolation(src, { directive: "img-src", blockedURI: src })).toBe(false);
    expect(isBlockedFrameViolation(src, { directive: "frame-src", blockedURI: "inline" })).toBe(
      false,
    );
  });
});
