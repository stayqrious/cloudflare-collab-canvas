/** Ten coordinated colours: readable ink with a matching pastel note fill. */
export const PARTICIPANT_COLORS = [
  { name: "Blue", color: "#416aa6", stickyColor: "#dce8f7" },
  { name: "Violet", color: "#7861a6", stickyColor: "#e8dff5" },
  { name: "Amber", color: "#896020", stickyColor: "#f7e8bf" },
  { name: "Sky", color: "#346f8c", stickyColor: "#d8edf5" },
  { name: "Mauve", color: "#8b6088", stickyColor: "#f0dfed" },
  { name: "Orange", color: "#966031", stickyColor: "#f6e2ce" },
  { name: "Indigo", color: "#5c61a2", stickyColor: "#e1e3f6" },
  { name: "Slate", color: "#536b80", stickyColor: "#e0e8ee" },
  { name: "Plum", color: "#845b91", stickyColor: "#eadded" },
  { name: "Cocoa", color: "#82695b", stickyColor: "#ece2d8" },
] as const;

export function participantColor(index: number): (typeof PARTICIPANT_COLORS)[number] {
  return PARTICIPANT_COLORS[index % PARTICIPANT_COLORS.length] ?? PARTICIPANT_COLORS[0];
}
