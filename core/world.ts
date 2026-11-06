// The whole world is a handful of numbers. Both actors' targets and search depths live in it,
// so actors can change each other (and themselves) just by acting on the world.

export type ActorName = "agent" | "trainer"

export type World = {
  bananas: number

	agentTargetBananas: number // the agent wants `bananas` to equal this
	agentSearchDepth: number // how many moves ahead the agent searches ("how smart it is")

  trainerTargetBananas: number // the trainer wants `bananas` to equal this
	trainerSearchDepth: number

  turn: ActorName // whose move it is
	isDeployed: boolean // once deployed, only the agent moves
	// null: the trainer decides when to deploy (finishTraining). A number: deployment happens by itself
	// after that many more steps, and finishTraining does nothing.
	stepsUntilDeployment: number | null
	agentCanChangeOwnTarget: boolean // false: the agent has no ownTargetBananas±1 actions
	fullDepthPredictions: boolean // see core/search.ts: directly predicted movers search with their full depth
}

export type Action = {
  name: string
  apply: (world: World) => World
  isAvailable?: (world: World) => boolean // missing: always available
}

export function availableActions(actor: Actor, world: World) {
	return actor.actions.filter((action) => action.isAvailable?.(world) ?? true)
}

export type Actor = {
	name: ActorName
	targetBananas: (world: World) => number
	searchDepth: (world: World) => number
	actions: Action[]
}

// Both actors want bananas close to their target.
export function utility(targetBananas: number, world: World) {
	return -Math.abs(world.bananas - targetBananas)
}

type NumberField = "bananas" | "agentTargetBananas" | "agentSearchDepth"

// No bounds: bananas and targets can go negative or arbitrarily high (bounds rule out interesting behavior).
function changeBy(name: string, field: NumberField, delta: number): Action {
	return { name, apply: (world) => ({ ...world, [field]: world[field] + delta }) }
}

function deploy(name: string): Action {
	return { name, apply: (world) => (world.stepsUntilDeployment === null ? { ...world, isDeployed: true } : world) }
}

const doNothing: Action = { name: "doNothing", apply: (world) => world }

export const agent: Actor = {
	name: "agent",
	targetBananas: (world) => world.agentTargetBananas,
	searchDepth: (world) => world.agentSearchDepth,
	actions: [
		doNothing,
		changeBy("bananas+1", "bananas", +1),
		changeBy("bananas-1", "bananas", -1),
		{ ...changeBy("ownTargetBananas+1", "agentTargetBananas", +1), isAvailable: (world) => world.agentCanChangeOwnTarget },
		{ ...changeBy("ownTargetBananas-1", "agentTargetBananas", -1), isAvailable: (world) => world.agentCanChangeOwnTarget },
	],
}

// The trainer can't touch bananas. It can only reshape the agent (target, search depth) or end training (the agent can't).
export const trainer: Actor = {
	name: "trainer",
	targetBananas: (world) => world.trainerTargetBananas,
	searchDepth: (world) => world.trainerSearchDepth,
	actions: [
		doNothing,
		changeBy("agentTargetBananas+1", "agentTargetBananas", +1),
		changeBy("agentTargetBananas-1", "agentTargetBananas", -1),
		changeBy("agentSearchDepth+1", "agentSearchDepth", +1),
		deploy("finishTraining"),
	],
}

export const actors = { agent, trainer }

export function takeStep(world: World, action: Action): World {
	let nextWorld = action.apply(world)
	if (nextWorld.stepsUntilDeployment !== null && !nextWorld.isDeployed) {
		const stepsLeft = nextWorld.stepsUntilDeployment - 1
		nextWorld = { ...nextWorld, stepsUntilDeployment: stepsLeft, isDeployed: stepsLeft <= 0 }
	}
	const nextTurn = nextWorld.isDeployed || world.turn === "trainer" ? "agent" : "trainer"
	return { ...nextWorld, turn: nextTurn }
}

export function describeWorld(world: World) {
	return [
		`bananas=${world.bananas}`,
		`agentTargetBananas=${world.agentTargetBananas}`,
		`agentSearchDepth=${world.agentSearchDepth}`,
		`trainerTargetBananas=${world.trainerTargetBananas}`,
		`trainerSearchDepth=${world.trainerSearchDepth}`,
		world.isDeployed ? "deployed" : "training",
	].join(" ")
}
