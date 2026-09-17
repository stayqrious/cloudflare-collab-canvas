import { describe, expect, it } from "vitest";
import { A5_PAGE, calibrate, parseCalibration, toPage } from "./calibration";

describe("Smart Note calibration", () => {
  const available = { left: 0, top: 100, width: 1920, height: 900 };
  it("maps different resolutions and aspect ratios to identical A5 coordinates", () => {
    const laptop = calibrate([100, 200], [500, 800], available);
    const desktop = calibrate([200, 150], [1800, 950], available);
    expect(laptop).not.toBeNull();
    expect(desktop).not.toBeNull();
    if (!laptop || !desktop) throw new Error("Expected valid calibration");
    expect(toPage(laptop, 300, 500)).toEqual([370, 525]);
    expect(toPage(desktop, 1000, 550)).toEqual([370, 525]);
    expect(toPage(laptop, 100, 200)).toEqual([0, 0]);
    expect(toPage(desktop, 1800, 950)).toEqual([A5_PAGE.width, A5_PAGE.height]);
  });
  it("rejects reversed, tiny, nonfinite and inaccessible rectangles", () => {
    for (const end of [
      [50, 800],
      [500, 120],
      [110, 205],
      [2000, 800],
      [NaN, 800],
    ] as const) {
      expect(calibrate([100, 200], [...end], available)).toBeNull();
    }
    expect(calibrate([-1, 200], [500, 800], available)).toBeNull();
  });
  it("reuses only validated calibration for the same display environment", () => {
    const calibration = {
      version: 1,
      environment: "laptop",
      area: { left: 100, top: 200, width: 400, height: 600 },
    };
    const raw = JSON.stringify(calibration);
    expect(parseCalibration(raw, "laptop", available)).toEqual(calibration);
    expect(parseCalibration(raw, "resized", available)).toBeNull();
    expect(parseCalibration("{", "laptop", available)).toBeNull();
    expect(
      parseCalibration(
        JSON.stringify({ ...calibration, area: { ...calibration.area, left: "100" } }),
        "laptop",
        available,
      ),
    ).toBeNull();
  });
});
