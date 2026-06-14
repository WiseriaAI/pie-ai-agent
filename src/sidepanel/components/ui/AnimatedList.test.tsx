import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { useAnimatedList } from "./AnimatedList";

afterEach(() => cleanup());

function Demo() {
  const [items, setItems] = useState(["a", "b"]);
  const ref = useAnimatedList<HTMLUListElement>();
  return (
    <div>
      <button onClick={() => setItems((x) => [...x, `n${x.length}`])}>add</button>
      <button onClick={() => setItems((x) => x.slice(1))}>remove</button>
      <ul ref={ref}>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

describe("useAnimatedList", () => {
  it("attaches to a list and reflects add/remove without crashing under auto-animate", () => {
    render(<Demo />);
    expect(screen.getByText("a")).toBeTruthy();
    fireEvent.click(screen.getByText("add"));
    expect(screen.getByText("n2")).toBeTruthy();
    fireEvent.click(screen.getByText("remove"));
    expect(screen.queryByText("a")).toBeNull();
  });
});
