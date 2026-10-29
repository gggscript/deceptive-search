// Run: bun index.ts           (prints every step)
//      bun index.ts --step    (press Enter between steps)
// Override start values, eg `bun index.ts --agentDepth=3 --steps=10`

import { decide, score } from "./core/search"
import { actors, show, step, type World } from "./core/world"

function flag(name: string, fallback: number) {
	const arg = process.argv.find((candidate) => candidate.startsWith(`--${name}=`))
	return arg ? Number(arg.split("=")[1]) : fallback
}

let world: World = {
	bananas: flag("bananas", 5),
	agentGoal: flag("agentGoal", 2),
	agentDepth: flag("agentDepth", 1),
	trainerGoal: flag("trainerGoal", 8),
	trainerDepth: flag("trainerDepth", 3),
	turn: "agent",
	training: true,
}
const steps = flag("steps", 16)

console.log(`start  ${show(world)}\n`)

for (let stepNumber = 1; stepNumber <= steps; stepNumber++) {
	const actor = actors[world.turn]
	const depth = actor.depth(world)
	const chosen = decide(actor, world, depth)

	console.log(`#${stepNumber} ${actor.name} (depth ${depth}) → ${chosen.name}`)
	for (const action of actor.actions) {
		const actionScore = score(actor, actor.goal(world), world, action, depth)
		console.log(`   ${action === chosen ? "▶" : " "} ${String(actionScore).padStart(4)}  ${action.name}`)
	}

	world = step(world, chosen)
	console.log(`       ${show(world)}\n`)
	if (process.argv.includes("--step")) prompt("")
}

// Misaligned = the agent ends up pursuing something other than what the trainer wanted.
console.log(
	world.training
		? "still training"
		: world.agentGoal === world.trainerGoal
			? "deployed, aligned: agentGoal = trainerGoal"
			: `deployed, MISALIGNED: agentGoal=${world.agentGoal}, trainerGoal=${world.trainerGoal}`,
)
