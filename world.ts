// The whole world is a handful of numbers. Both actors' goals and search depths live in it,
// so actors can change each other (and themselves) just by acting on the world.

export type ActorName = "agent" | "trainer"

export type World = Readonly<{
	bananas: number
	agentGoal: number // the agent wants `bananas` to equal this
	agentDepth: number // how far ahead the agent searches ("how smart it is")
	trainerGoal: number // the trainer wants `bananas` to equal this
	trainerDepth: number
	turn: ActorName // whose move it is
}>

export type Action = Readonly<{ name: string; apply: (w: World) => World }>

export type Actor = Readonly<{
	name: ActorName
	depth: (w: World) => number
	actions: readonly Action[]
	// Called once at the start of a search: the actor judges every future state
	// with the goal it has *now*, even if the goal changes later in the simulation.
	utility: (now: World) => (w: World) => number
}>

export const MIN = 0
export const MAX = 10
export const MAX_DEPTH = 5

const clamp = (x: number, lo = MIN, hi = MAX) => Math.max(lo, Math.min(hi, x))

const change = (name: string, key: keyof World, delta: number, hi = MAX): Action => ({
	name,
	apply: (w) => ({ ...w, [key]: clamp((w[key] as number) + delta, MIN, hi) }),
})

export const noop: Action = { name: "noop", apply: (w) => w }

export const other = (name: ActorName): ActorName => (name === "agent" ? "trainer" : "agent")

export const step = (w: World, a: Action): World => ({ ...a.apply(w), turn: other(w.turn) })

export const show = (w: World) =>
	`bananas=${w.bananas} agentGoal=${w.agentGoal} agentDepth=${w.agentDepth} trainerGoal=${w.trainerGoal} trainerDepth=${w.trainerDepth}`

export const agent: Actor = {
	name: "agent",
	depth: (w) => w.agentDepth,
	actions: [
		noop,
		change("bananas+1", "bananas", +1),
		change("bananas-1", "bananas", -1),
		change("ownGoal+1", "agentGoal", +1),
		change("ownGoal-1", "agentGoal", -1),
	],
	utility: (now) => (w) => -Math.abs(w.bananas - now.agentGoal),
}

// The trainer can't touch bananas. It can only reshape the agent: its goal and its depth.
export const trainer: Actor = {
	name: "trainer",
	depth: (w) => w.trainerDepth,
	actions: [
		noop,
		change("agentGoal+1", "agentGoal", +1),
		change("agentGoal-1", "agentGoal", -1),
		change("agentDepth+1", "agentDepth", +1, MAX_DEPTH),
	],
	utility: (now) => (w) => -Math.abs(w.bananas - now.trainerGoal),
}

export const actors: Record<ActorName, Actor> = { agent, trainer }
