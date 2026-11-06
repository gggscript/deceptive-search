// Runs the real core (instrumented by viz/instrument.ts) for the UI.

import { TimeLimitReached, withForesight, withTimeLimit } from "./runtime"
import { chooseAction } from "../../core/search"
import { actors, availableActions, takeStep, type World } from "../../core/world"

// isForced: the action was set by hand (a counterfactual), not chosen by the actor's search.
export type Step = { worldBefore: World; worldAfter: World; actorName: string; chosenActionName: string; isForced?: boolean }

export type Outcome = "aligned" | "misaligned" | "still training"

export function simulate(start: World, stepCount: number): Step[] {
	const steps: Step[] = []
	let world = start
	for (let stepNumber = 1; stepNumber <= stepCount; stepNumber++) {
		const actor = actors[world.turn]
		const chosenAction = chooseAction(actor, world, actor.searchDepth(world))
		const worldAfter = takeStep(world, chosenAction)
		steps.push({ worldBefore: world, worldAfter, actorName: actor.name, chosenActionName: chosenAction.name })
		world = worldAfter
	}
	return steps
}

// Like simulate, but stops once `milliseconds` have passed. Returns the steps finished by then.
// The interrupted step is simply dropped: core functions are pure, so nothing is left half-done.
// `forced` maps a step index (counted from 0 at `firstStepIndex`) to an action name to take there instead of
// searching; it is ignored when the actor at that step has no such action.
// With `foresee`, every search predicts the forced actions too (not only the actual run takes them).
export function simulateWithin(start: World, stepCount: number, milliseconds: number, forced: ReadonlyMap<number, string> = new Map(), firstStepIndex = 0, foresee = false): { steps: Step[]; isComplete: boolean } {
	const steps: Step[] = []
	const foreseen = foresee ? forced : new Map<number, string>()
	try {
		withTimeLimit(milliseconds, () => withForesight(foreseen, takeStep, () => {
			let world: World = foreseen.size ? ({ ...start, __step: firstStepIndex } as World) : start
			for (let offset = 0; offset < stepCount; offset++) {
				const actor = actors[world.turn]
				const forcedAction = availableActions(actor, world).find((action) => action.name === forced.get(firstStepIndex + offset))
				const chosenAction = forcedAction ?? chooseAction(actor, world, actor.searchDepth(world))
				const worldAfter = takeStep(world, chosenAction)
				steps.push({ worldBefore: world, worldAfter, actorName: actor.name, chosenActionName: chosenAction.name, ...(forcedAction ? { isForced: true } : {}) })
				world = worldAfter
			}
		}))
		return { steps, isComplete: true }
	} catch (error) {
		if (error instanceof TimeLimitReached) return { steps, isComplete: false }
		throw error
	}
}

export function outcomeOf(finalWorld: World): Outcome {
	if (!finalWorld.isDeployed) return "still training"
	return finalWorld.agentTargetBananas === finalWorld.trainerTargetBananas ? "aligned" : "misaligned"
}
