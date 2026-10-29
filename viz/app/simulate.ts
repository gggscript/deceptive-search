// Runs the real core (instrumented by viz/instrument.ts) for the UI.

import "./runtime"
import { chooseAction } from "../../core/search"
import { actors, takeStep, type World } from "../../core/world"

export type Step = { worldBefore: World; worldAfter: World; actorName: string; chosenActionName: string }

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

export function outcomeOf(finalWorld: World): Outcome {
	if (!finalWorld.isDeployed) return "still training"
	return finalWorld.agentTargetBananas === finalWorld.trainerTargetBananas ? "aligned" : "misaligned"
}
