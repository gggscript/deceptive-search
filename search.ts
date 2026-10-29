// Tree search with "double search": when an actor simulates the other actor's move,
// it predicts that move by running the other actor's own search.
//
// Why this terminates: an actor can't look past its own horizon, so a nested search
// gets at most the plies that remain in the outer search. Every nesting level has a
// strictly smaller horizon, so the recursion bottoms out.

import { actors, type Action, type Actor, type World, step } from "./world"

export type Ply = Readonly<{ by: string; action: string; nested: boolean }>
export type Line = readonly Ply[]
export type Option = Readonly<{ action: Action; value: number; line: Line }>

export const stats = { nodes: 0 }

// Value of `w` for `me` (judging with the frozen utility `u`), over the next `remaining` plies.
// Value = sum of utility over the states visited, so sooner is better than later.
const value = (me: Actor, u: (w: World) => number, w: World, remaining: number): { value: number; line: Line } => {
	stats.nodes++
	if (remaining === 0) return { value: 0, line: [] }

	if (w.turn === me.name) {
		// My own move: branch over all my actions.
		return best(me, u, w, remaining)
	}

	// Their move: predict it by running their search, limited to what remains of mine.
	const them = actors[w.turn]
	const theirs = decide(them, w, Math.min(them.depth(w), remaining))
	const next = step(w, theirs.action)
	const rest = value(me, u, next, remaining - 1)
	return {
		value: u(next) + rest.value,
		line: [{ by: them.name, action: theirs.action.name, nested: true }, ...rest.line],
	}
}

const best = (me: Actor, u: (w: World) => number, w: World, remaining: number) => {
	const options = evaluate(me, u, w, remaining)
	// Ties go to the earliest action in the list (noop first).
	return options.reduce((a, b) => (b.value > a.value ? b : a))
}

const evaluate = (me: Actor, u: (w: World) => number, w: World, remaining: number): Option[] =>
	me.actions.map((action) => {
		const next = step(w, action)
		const rest = value(me, u, next, remaining - 1)
		return {
			action,
			value: u(next) + rest.value,
			line: [{ by: me.name, action: action.name, nested: false }, ...rest.line],
		}
	})

/** What `me` does in `w`, looking `horizon` plies ahead. Returns every option, best first. */
export const decide = (me: Actor, w: World, horizon: number): Option & { options: Option[] } => {
	const u = me.utility(w)
	if (horizon <= 0) return { action: me.actions[0]!, value: 0, line: [], options: [] }
	const options = evaluate(me, u, w, horizon)
	const chosen = options.reduce((a, b) => (b.value > a.value ? b : a))
	return { ...chosen, options: [...options].sort((a, b) => b.value - a.value) }
}
