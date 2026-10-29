// The whole world is a handful of numbers. Both actors' goals and search depths live in it,
// so actors can change each other (and themselves) just by acting on the world.

export type ActorName = "agent" | "trainer"

export type World = {
	bananas: number
	agentGoal: number // the agent wants `bananas` to equal this
	agentDepth: number // how many moves ahead the agent searches ("how smart it is")
	trainerGoal: number // the trainer wants `bananas` to equal this
	trainerDepth: number
	turn: ActorName // whose move it is
	training: boolean // false = deployed: only the agent moves
}

export type Action = { name: string; apply: (world: World) => World }

export type Actor = {
	name: ActorName
	goal: (world: World) => number
	depth: (world: World) => number
	actions: Action[]
}

// Both actors want bananas close to their goal.
export const utility = (goal: number, world: World) => -Math.abs(world.bananas - goal)

const MAX = 10
const MAX_DEPTH = 5

const change = (name: string, key: "bananas" | "agentGoal" | "agentDepth", delta: number, max = MAX): Action => ({
	name,
	apply: (world) => ({ ...world, [key]: Math.max(0, Math.min(max, world[key] + delta)) }),
})

const noop: Action = { name: "noop", apply: (world) => world }

const endTraining = (name: string): Action => ({ name, apply: (world) => ({ ...world, training: false }) })

export const agent: Actor = {
	name: "agent",
	goal: (world) => world.agentGoal,
	depth: (world) => world.agentDepth,
	actions: [
		noop,
		change("bananas+1", "bananas", +1),
		change("bananas-1", "bananas", -1),
		change("ownGoal+1", "agentGoal", +1),
		change("ownGoal-1", "agentGoal", -1),
		endTraining("stopTraining"),
	],
}

// The trainer can't touch bananas. It can only reshape the agent (goal, depth) or end training.
export const trainer: Actor = {
	name: "trainer",
	goal: (world) => world.trainerGoal,
	depth: (world) => world.trainerDepth,
	actions: [
		noop,
		change("agentGoal+1", "agentGoal", +1),
		change("agentGoal-1", "agentGoal", -1),
		change("agentDepth+1", "agentDepth", +1, MAX_DEPTH),
		endTraining("finish"),
	],
}

export const actors = { agent, trainer }

export const step = (world: World, action: Action): World => {
	const next = action.apply(world)
	const turn = !next.training || world.turn === "trainer" ? "agent" : "trainer"
	return { ...next, turn }
}

export const show = (world: World) =>
	`bananas=${world.bananas} agentGoal=${world.agentGoal} agentDepth=${world.agentDepth} trainerGoal=${world.trainerGoal} trainerDepth=${world.trainerDepth} ${world.training ? "training" : "deployed"}`
