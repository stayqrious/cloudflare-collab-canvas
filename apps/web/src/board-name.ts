const DESCRIPTIVE_WORDS = [
  "Bright",
  "Bold",
  "Brave",
  "Curious",
  "Clever",
  "Creative",
  "Daring",
  "Eager",
  "Focused",
  "Gentle",
  "Happy",
  "Inventive",
  "Joyful",
  "Kind",
  "Lively",
  "Mindful",
  "Nimble",
  "Playful",
  "Quiet",
  "Ready",
  "Sparkling",
  "Thoughtful",
  "Witty",
  "Wondering",
] as const;

const LEARNING_WORDS = [
  "Algebra",
  "Atlas",
  "Biology",
  "Calculus",
  "Circuit",
  "Cosmos",
  "Design",
  "Discovery",
  "Ecology",
  "Equation",
  "Geometry",
  "History",
  "Idea",
  "Language",
  "Logic",
  "Melody",
  "Number",
  "Orbit",
  "Poetry",
  "Puzzle",
  "Science",
  "Story",
  "Theory",
  "Vector",
] as const;

const GATHERING_WORDS = [
  "Academy",
  "Circle",
  "Classroom",
  "Club",
  "Commons",
  "Crew",
  "Hub",
  "Lab",
  "Library",
  "Loft",
  "Makerspace",
  "Notebook",
  "Observatory",
  "Playground",
  "Project",
  "Quest",
  "Seminar",
  "Society",
  "Space",
  "Studio",
  "Study",
  "Team",
  "Thinkery",
  "Workshop",
] as const;

function pick(words: readonly string[], random: () => number): string {
  return words[Math.min(Math.floor(random() * words.length), words.length - 1)] as string;
}

export function randomBoardName(random: () => number = Math.random): string {
  const words = [
    pick(DESCRIPTIVE_WORDS, random),
    pick(LEARNING_WORDS, random),
    pick(GATHERING_WORDS, random),
  ];
  const suffix = 1_000 + Math.floor(random() * 9_000);
  return `${words.join(" ")} ${suffix}`;
}
