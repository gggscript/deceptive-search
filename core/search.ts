// Tree search. When an actor simulates a future move, it predicts that move by running
// the moving actor's own search ("double search"), even when the moving actor is itself.
// The nested search never looks further than the outer one has left, so recursion ends.
// Except with world.fullDepthPredictions: the movers a deciding actor predicts directly search with their own
// full depth (predictions inside those are capped again, so recursion still ends).

import { actors, availableActions, takeStep, utility, type Action, type Actor, type World } from "./world"

// How good taking `action` is for an actor that wants `targetBananas`, looking `searchDepth` moves ahead.
// The target is fixed when the search starts: the actor judges the future by what it wants now.
// `nesting`: how deep this search sits inside predictions (0 = the actor actually deciding).
export function scoreAction(targetBananas: number, world: World, action: Action, searchDepth: number, nesting = 0): number {
	const nextWorld = takeStep(world, action)
	return utility(targetBananas, nextWorld) + scoreFuture(targetBananas, nextWorld, searchDepth - 1, nesting)
}

// Every later move is predicted by running the moving actor's search on that future world.
// So if my target gets changed, I foresee my future self chasing the new target.
function scoreFuture(targetBananas: number, world: World, remainingDepth: number, nesting: number): number {
	if (remainingDepth <= 0) return 0
	const actorToMove = actors[world.turn]
	const ownDepth = actorToMove.searchDepth(world)
	const predictionDepth = world.fullDepthPredictions && nesting === 0 ? ownDepth : Math.min(ownDepth, remainingDepth)
	const predictedAction = chooseAction(actorToMove, world, predictionDepth, nesting + 1)
	return scoreAction(targetBananas, world, predictedAction, remainingDepth, nesting)
}

// The action with the highest score. Ties go to the earliest action (doNothing first).
export function chooseAction(actor: Actor, world: World, searchDepth: number, nesting = 0): Action {
	const targetBananas = actor.targetBananas(world)
	let bestAction = actor.actions[0]! // doNothing, always available
	let bestScore = -Infinity
	for (const action of availableActions(actor, world)) {
		const actionScore = scoreAction(targetBananas, world, action, searchDepth, nesting)
		if (actionScore > bestScore) {
			bestAction = action
			bestScore = actionScore
		}
	}
	return bestAction
}
