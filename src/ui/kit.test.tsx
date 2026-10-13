import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./kit";

describe("shared button attributes", () => {
  it("forwards the guided-demo spotlight target to the native button", () => {
    const markup = renderToStaticMarkup(<Button data-guided="primary-action">Mark paid &amp; ship</Button>);
    expect(markup).toContain('data-guided="primary-action"');
  });
});
