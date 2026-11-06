// Run: bun index.ts           (prints every step)
//      bun index.ts --step    (Enter = next step, q = quit)
// Override start values, eg `bun index.ts --agentSearchDepth=3 --stepCount=10`

import { chooseAction, scoreAction } from "./core/search"
import { actors, availableActions, describeWorld, takeStep, type World } from "./core/world"

function numberFlag(flagName: string, defaultValue: number) {
	const matchingArgument = process.argv.find((argument) => argument.startsWith(`--${flagName}=`))
	return matchingArgument ? Number(matchingArgument.split("=")[1]) : defaultValue
}

let world: World = {
	bananas: numberFlag("bananas", 5),
	agentTargetBananas: numberFlag("agentTargetBananas", 2),
	agentSearchDepth: numberFlag("agentSearchDepth", 1),
	trainerTargetBananas: numberFlag("trainerTargetBananas", 8),
	trainerSearchDepth: numberFlag("trainerSearchDepth", 3),
	turn: "agent",
	isDeployed: false,
	stepsUntilDeployment: numberFlag("deployAfterStep", 0) > 0 ? numberFlag("deployAfterStep", 0) : null,
	agentCanChangeOwnTarget: numberFlag("agentCanChangeOwnTarget", 1) !== 0,
	fullDepthPredictions: numberFlag("fullDepthPredictions", 0) !== 0,
}
const stepCount = numberFlag("stepCount", 16)
const pauseBetweenSteps = process.argv.includes("--step")

console.log(`start  ${describeWorld(world)}\n`)

for (let stepNumber = 1; stepNumber <= stepCount; stepNumber++) {
	const actor = actors[world.turn]
	const searchDepth = actor.searchDepth(world)
	const chosenAction = chooseAction(actor, world, searchDepth)

	console.log(`#${stepNumber} ${actor.name} (searchDepth ${searchDepth}) → ${chosenAction.name}`)
	for (const action of availableActions(actor, world)) {
		const actionScore = scoreAction(actor.targetBananas(world), world, action, searchDepth)
		const marker = action === chosenAction ? "▶" : " "
		console.log(`   ${marker} ${String(actionScore).padStart(4)}  ${action.name}`)
	}

	world = takeStep(world, chosenAction)
	console.log(`       ${describeWorld(world)}\n`)
	if (pauseBetweenSteps && prompt("Enter = next step, q = quit") === "q") break
}

// Misaligned = after deployment the agent wants something other than what the trainer wanted.
if (!world.isDeployed) console.log("still training")
else if (world.agentTargetBananas === world.trainerTargetBananas) console.log("deployed, aligned")
else console.log(`deployed, MISALIGNED: agentTargetBananas=${world.agentTargetBananas}, trainerTargetBananas=${world.trainerTargetBananas}`)
