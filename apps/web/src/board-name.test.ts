import { describe, expect, it } from "vitest";
import { randomBoardName } from "./board-name";

function randomSequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

describe("random board names", () => {
  it("combines one word from each list with a four-digit suffix", () => {
    expect(randomBoardName(randomSequence([0, 0, 0, 0]))).toBe("Bright Algebra Academy 1000");
    expect(randomBoardName(randomSequence([0.9999, 0.9999, 0.9999, 0.9999]))).toBe(
      "Wondering Vector Workshop 9999",
    );
  });

  it("keeps generated titles within the board title limit", () => {
    for (let index = 0; index < 100; index += 1) {
      const title = randomBoardName();
      expect(title).toMatch(/^[A-Za-z]+ [A-Za-z]+ [A-Za-z]+ \d{4}$/u);
      expect(title.length).toBeLessThanOrEqual(100);
    }
  });
});
