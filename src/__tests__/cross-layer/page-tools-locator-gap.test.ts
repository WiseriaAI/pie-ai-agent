import { describe, expect, it, beforeEach } from "vitest";
import { pageSnapshotInjected } from "../../lib/dom-actions/page-snapshot";
import { searchPageInjected } from "../../lib/dom-actions/search-page";
import { typeByIndex } from "../../lib/dom-actions/type";

describe("page tools locator gap cross-layer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.querySelectorAll("[data-pie-idx]").forEach((el) => el.removeAttribute("data-pie-idx"));
  });

  it("large HTML can be truncated while blank editor remains discoverable and typable", async () => {
    document.body.innerHTML = `
      <main>
        <p>${"x".repeat(130_000)}</p>
        <h2>Reply</h2>
        <div id="reply" contenteditable="true"></div>
      </main>
    `;
    const reply = document.getElementById("reply") as HTMLElement;
    Object.defineProperty(reply, "getBoundingClientRect", {
      value: () => ({ width: 300, height: 48, top: 0, left: 0, right: 300, bottom: 48 }),
      configurable: true,
    });

    const snapshot = pageSnapshotInjected();
    const editor = snapshot.interactiveElements.find((el) => el.contenteditable);

    expect(snapshot.html.length).toBeGreaterThan(120_000);
    expect(editor).toEqual(expect.objectContaining({ role: "textbox", contenteditable: true }));

    const search = searchPageInjected({
      queries: ["textbox"],
      regex: false,
      mode: "interactive",
      maxResults: 10,
      searchBy: "role",
    });

    expect(search.matches[0].pieIdx).toBe(editor!.pieIdx);

    const typed = await typeByIndex(editor!.pieIdx, "Thanks for the update.", false);
    expect(typed.success).toBe(true);
    expect(reply.textContent).toContain("Thanks for the update.");
  });
});
