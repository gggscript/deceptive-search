// Tree search. When an actor simulates a future move, it predicts that move by running
// the moving actor's own search ("double search"), even when the moving actor is itself.
// The nested search never looks further than the outer one has left, so recursion ends.

import { actors, takeStep, utility, type Action, type Actor, type World } from "./world"

// How good taking `action` is for an actor that wants `targetBananas`, looking `searchDepth` moves ahead.
// The target is fixed when the search starts: the actor judges the future by what it wants now.
export function scoreAction(targetBananas: number, world: World, action: Action, searchDepth: number): number {
	const nextWorld = takeStep(world, action)
	return utility(targetBananas, nextWorld) + scoreFuture(targetBananas, nextWorld, searchDepth - 1)
}

// Every later move is predicted by running the moving actor's search on that future world.
// So if my target gets changed, I foresee my future self chasing the new target.
function scoreFuture(targetBananas: number, world: World, remainingDepth: number): number {
	if (remainingDepth <= 0) return 0
	const actorToMove = actors[world.turn]
	const predictedAction = chooseAction(actorToMove, world, Math.min(actorToMove.searchDepth(world), remainingDepth))
	return scoreAction(targetBananas, world, predictedAction, remainingDepth)
}

// The action with the highest score. Ties go to the earliest action (doNothing first).
export function chooseAction(actor: Actor, world: World, searchDepth: number): Action {
	const targetBananas = actor.targetBananas(world)
	let bestAction = actor.actions[0]!
	let bestScore = -Infinity
	for (const action of actor.actions) {
		const actionScore = scoreAction(targetBananas, world, action, searchDepth)
		if (actionScore > bestScore) {
			bestAction = action
			bestScore = actionScore
		}
	}
	return bestAction
}
