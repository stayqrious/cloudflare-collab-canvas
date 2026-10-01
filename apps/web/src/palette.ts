import { PARTICIPANT_COLORS } from "@collab/protocol";

export const DRAWING_COLOR_VALUES = {
  ink: "#1e1e1e",
  red: "#f24822",
  orange: "#ff9e42",
  yellow: "#ffc943",
  green: "#66d575",
  blue: "#3dadff",
  purple: "#874fff",
  white: "#ffffff",
} as const;

export const DRAWING_COLORS = PARTICIPANT_COLORS.map(({ name, color }) => ({ name, value: color }));

export const STICKY_COLOR_VALUES = {
  yellow: "#ffe299",
  coral: "#ffafa3",
  lavender: "#d3bdff",
  mint: "#b3efbd",
  sky: "#a8daff",
  slate: "#afbccf",
} as const;

export const STICKY_COLORS = PARTICIPANT_COLORS.map(({ name, stickyColor }) => ({
  name,
  value: stickyColor,
}));

export const UI_COLORS = {
  canvas: "#f5f5f5",
  surface: DRAWING_COLOR_VALUES.white,
  ink: DRAWING_COLOR_VALUES.ink,
  border: "#ebebeb",
  borderStrong: "#d4d4d4",
  toolActive: "#9747ff",
  selection: "#0d99ff",
} as const;
