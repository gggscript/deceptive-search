// Tree search. When an actor simulates the other actor's move, it predicts that move
// by running the other actor's own search ("double search").
// The nested search never looks further than the outer one has left, so recursion ends.

import { actors, step, utility, type Action, type Actor, type World } from "./world"

// How good taking `action` is for someone with `goal`, looking `depth` moves ahead.
// The goal is fixed when the search starts: the actor judges the future by what it wants now.
export const score = (actor: Actor, goal: number, world: World, action: Action, depth: number): number => {
	const next = step(world, action)
	return utility(goal, next) + scoreWorld(actor, goal, next, depth - 1)
}

const scoreWorld = (actor: Actor, goal: number, world: World, depth: number): number => {
	if (depth === 0) return 0
	if (world.turn === actor.name) {
		return Math.max(...actor.actions.map((action) => score(actor, goal, world, action, depth)))
	}
	const other = actors[world.turn]
	const predicted = decide(other, world, Math.min(other.depth(world), depth))
	return score(actor, goal, world, predicted, depth)
}

// The action with the highest score. Ties go to the earliest action (noop first).
export const decide = (actor: Actor, world: World, depth: number): Action => {
	let best = actor.actions[0]!
	let bestScore = -Infinity
	for (const action of actor.actions) {
		const actionScore = score(actor, actor.goal(world), world, action, depth)
		if (actionScore > bestScore) [best, bestScore] = [action, actionScore]
	}
	return best
}
