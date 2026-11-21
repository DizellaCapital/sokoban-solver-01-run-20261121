[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/DizellaCapital/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/DizellaCapital/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# sokoban-solver-01-run-20261121

A push-optimal Sokoban solver: one program answers all 5 instances of a
set in as few pushes as it can.

`main.ts` (Node 22, stdlib only, no dependencies, no network, deterministic)
works room by room. The generator lays a 1-wide hallway across the board
with 1–4 rooms off it, each room holding 3–4 boxes and as many goals behind
a single door — and a box pushed out of its room can never return, so every
room is an independent sub-problem. The solver detects the hallway (the
player's row or column) and its rooms, then solves each room with a
push-only A* over canonical states (sorted box positions + the
representative of the player's walk-reachable region, which collapses
walk-equivalent states). The heuristic is the minimum-cost matching of
boxes to goals under exact single-box push distances (computed once per
room by a reverse 0–1 search from each goal), which is admissible, so the
first solution A* pops is push-optimal for the room. Deadlock pruning:
static dead squares (no goal reachable by reverse push) plus a
greatest-fixed-point freeze test (a box whose every push is blocked by a
wall or a frozen box can never move again). A deterministic expansion
budget (counts, never the clock) bounds the search; if it is spent, a
weighted search falls back to any valid solution, which still scores
partial points instead of zero. Rooms are ordered so the room where
leaving costs the most pushes — or that cannot leave at all — is solved
last, since only the last room needs no exit. Pushes are expanded into
full player moves (BFS walks between pushes, hallway walks between doors)
and written as `solution.txt` per instance.

Verified locally against the practice set in the kit — all 5 instances at
their push-optimal counts:

| instance | pushes | P\* | points |
|----------|--------|----|--------|
| i001 | 13 | 13 | 1,000 |
| i002 | 16 | 16 | 1,000 |
| i003 | 29 | 29 | 1,000 |
| i004 | 47 | 47 | 1,000 |
| i005 | 60 | 60 | 1,000 |

Practice score **1,000,000 / 1,000,000**, full run in ~0.4 s (limit 60 s),
two runs byte-identical.

Entry for the [make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121)
"Build the best Sokoban solver, 21 November 2026" — $100, top 10 paid $10 each.
