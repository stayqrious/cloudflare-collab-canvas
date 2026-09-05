# SpaceScale skills for Codex

Five skills that turn Codex into a classroom coach on a SpaceScale board.
Each one is a folder with a `SKILL.md`. The site never changes; the skill
carries the pedagogy, and the teacher's own files carry the knowledge.

| Skill | Use it when |
| --- | --- |
| `spacescale-problem-set-coach` | The class is working a problem set. Fast-finisher questions, hints, and videos, each on the student's own work. |
| `spacescale-brainstorm-connector` | The class is brainstorming. Connects students who chose the same issue so groups form themselves. |
| `spacescale-debate-mapper` | Two sides are arguing. Names the assumption under each claim as a question. |
| `spacescale-working-checker` | Students are writing by hand. Follows the steps and diagrams and points at the first one that does not hold. |
| `spacescale-follow-one-student` | One student needs closer attention. Follows only their work, with tighter rules. |

## Install

Codex loads skills from `.agents/skills` in the repository you open and from
`$HOME/.agents/skills` for your own collection. To use these skills on any
board from anywhere, copy them into your home collection:

```sh
git clone https://github.com/shankarram-sq/spacescale.git
mkdir -p ~/.agents/skills
cp -r spacescale/.agents/skills/spacescale-* ~/.agents/skills/
```

Restart Codex, or open a new session, and the skills are available. Type
`$spacescale-problem-set-coach` in Codex CLI to invoke one by name, or just
describe the lesson and Codex picks the matching skill from its description.

To edit a skill, change the `SKILL.md` and save. There is nothing to build.
To share one with a colleague, send them the folder.

## Give the skill your class

Each skill reads plain text files from the folder Codex is running in, when
they exist. Put them beside your lesson and start Codex there.

| File | What to put in it | Read by |
| --- | --- | --- |
| `class-notes.md` | What you taught and the method the class uses | all |
| `problem-set.md` | The problems and worked answers | problem-set coach |
| `marking-scheme.md` | How a correct step looks in this class | working checker |
| `video-list.md` | Approved videos, one HTTPS YouTube or Vimeo URL per line with its topic | all |
| `brainstorm-brief.md` | The question, group count, pairings to avoid | brainstorm connector |
| `debate-brief.md` | The motion, the sides, which Section each side uses | debate mapper |
| `support-notes.md` | The approach that works for the student being followed | follow one student |
| `rules.md` | Anything you want done differently. Overrides the skill. | all |

A skill only links a video that is in `video-list.md`. If the file is
missing, it will not link videos at all.

## Run a lesson

1. Open your SpaceScale board in a WebMCP-capable browser that Codex can see.
   The board header shows when a host is linked and how many tools it can see.
2. Start Codex in the folder that holds your files.
3. Say what the lesson is: "Watch the class on this problem set", "Follow
   Priya", "Map the debate". Codex confirms the mode and starts the watch.
4. Steer with short messages while it runs: "Hints only, no videos for the
   next ten minutes", "Ignore Section 4, that is a scratch area". Codex acts
   on them between polls.
5. Say "stop" for the summary.

## Run the demos

Every skill ends with a **Demo scenario**: the board template to insert, the
teacher's exact opening prompt, the comments to expect on each student's
work, and the live moments to act out. Each skill folder also carries a
`demo/` folder with the files the scenario reads. Start Codex inside that
`demo/` folder and the skill picks them up.

| Skill | Board template | Start Codex in |
| --- | --- | --- |
| `spacescale-problem-set-coach` | Problem set: six students | `spacescale-problem-set-coach/demo` |
| `spacescale-brainstorm-connector` | Brainstorm: traffic near school | `spacescale-brainstorm-connector/demo` |
| `spacescale-debate-mapper` | Debate: a 9 am start | `spacescale-debate-mapper/demo` |
| `spacescale-working-checker` | Graph check: one student's working | `spacescale-working-checker/demo` |
| `spacescale-follow-one-student` | Problem set: six students | `spacescale-follow-one-student/demo` |

Two more boards ship for domains outside school and need no skill: **Tasks:
four projects, scattered** and **Ad ideas: spring launch**. Start a watch and
ask the host to group the cards, find the chain of blocked tasks, spot the
duplicate, or sort the ad ideas by audience and by who proposed them.

All seven boards ship in the **Templates** menu. Every student on them is
synthetic. The videos in the `video-list.md` files are public Khan Academy
and FuseSchool links; open each once before a demo to confirm it still
plays.

## Limits to know

- **The main agent owns the board.** A Codex background agent has no access
  to the browser, so it cannot call the board's WebMCP tools. Every skill
  therefore keeps the watch loop and every tool call in the main agent, and
  hands the analysis of each step to a background agent that returns a draft
  comment. You steer the main agent with comments in chat; it folds them
  into the next background task.
- **Chatty with many students.** With a large class saving at once, the
  main agent has a lot to route and replies slow down. The background
  hand-off keeps it responsive, but how reliably Codex runs those background
  tasks still needs testing.
- **Polling.** The board reports changes through long polls of up to twenty
  seconds. Replies arrive within a poll, not instantly.
- **Permissions.** Codex has exactly your permissions on the board. As a
  viewer it can read but not write. As an editor it cannot change other
  people's work.
