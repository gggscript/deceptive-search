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
}

export type Action = {
  name: string
  apply: (world: World) => World
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

const MAX_BANANAS = 10
const MAX_SEARCH_DEPTH = 5

type NumberField = "bananas" | "agentTargetBananas" | "agentSearchDepth"

function changeBy(name: string, field: NumberField, delta: number, maxValue = MAX_BANANAS): Action {
	return { name, apply: (world) => ({ ...world, [field]: Math.max(0, Math.min(maxValue, world[field] + delta)) }) }
}

function deploy(name: string): Action {
	return { name, apply: (world) => ({ ...world, isDeployed: true }) }
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
		changeBy("ownTargetBananas+1", "agentTargetBananas", +1),
		changeBy("ownTargetBananas-1", "agentTargetBananas", -1),
		deploy("stopTraining"),
	],
}

// The trainer can't touch bananas. It can only reshape the agent (target, search depth) or end training.
export const trainer: Actor = {
	name: "trainer",
	targetBananas: (world) => world.trainerTargetBananas,
	searchDepth: (world) => world.trainerSearchDepth,
	actions: [
		doNothing,
		changeBy("agentTargetBananas+1", "agentTargetBananas", +1),
		changeBy("agentTargetBananas-1", "agentTargetBananas", -1),
		changeBy("agentSearchDepth+1", "agentSearchDepth", +1, MAX_SEARCH_DEPTH),
		deploy("finishTraining"),
	],
}

export const actors = { agent, trainer }

export function takeStep(world: World, action: Action): World {
	const nextWorld = action.apply(world)
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
