/// <reference lib="webworker" />
// Runs the searches off the page's main thread, so the page never freezes. Requests come in channels
// ("run", "unforced", "counterfactual", "sweep"); a newer request on a channel cancels the older one at its
// next step. Results stream back step by step (runs) or cell by cell (sweep). The cache lives here and persists.

import { TimeLimitReached, withForesight, withTimeLimit } from "./runtime"
import { chooseAction, scoreAction } from "../../core/search"
import { actors, availableActions, takeStep, type World } from "../../core/world"
import type { Step } from "./simulate"

export type RunRequest = {
	type: "run"
	channel: string
	id: number
	start: World
	stepCount: number
	limitMs: number
	forced: [number, string][]
	foresee: boolean
	firstStepIndex: number // the step index of `start`, for forced actions
}
export type SweepJob = { x: number; y: number; start: World; stepCount: number }
export type SweepRequest = { type: "sweep"; channel: string; id: number; jobs: SweepJob[]; cellLimitMs: number }
export type WorkerRequest = RunRequest | SweepRequest

export type SweepCellResult = { x: number; y: number; finalWorld: World; deployedAtStep: number | null; isComplete: boolean }
export type WorkerResponse =
	| { type: "run"; channel: string; id: number; firstIndex: number; steps: Step[]; done: boolean; isComplete: boolean }
	| { type: "sweep"; channel: string; id: number; cells: SweepCellResult[]; done: boolean; milliseconds: number }

const latestIdByChannel = new Map<string, number>()
const isCurrent = (channel: string, id: number) => latestIdByChannel.get(channel) === id

// The main run first; lower channels wait while a higher one has work, so they don't slow it down.
const PRIORITY: Record<string, number> = { run: 0, counterfactual: 1, unforced: 2, sweep: 3 }
const busyChannels = new Set<string>()
async function waitForTurn(channel: string) {
	const priority = PRIORITY[channel] ?? 9
	while ([...busyChannels].some((other) => (PRIORITY[other] ?? 9) < priority)) await yieldToMessages()
}

// Yield to the message queue between steps, so a newer request can arrive and cancel this one.
// A MessageChannel is faster than setTimeout(0), which browsers slow down to 4ms when nested.
const yieldChannel = new MessageChannel()
const waitingForYield: (() => void)[] = []
yieldChannel.port1.onmessage = () => waitingForYield.shift()?.()
const yieldToMessages = () => new Promise<void>((resolve) => {
	waitingForYield.push(resolve)
	yieldChannel.port2.postMessage(0)
})

// The other actions that scored as well as the chosen one (it only won because it comes first).
function tiedWith(world: World, chosenName: string) {
	const actor = actors[world.turn]
	const depth = actor.searchDepth(world)
	const target = actor.targetBananas(world)
	const scores = availableActions(actor, world).map((action) => ({ name: action.name, score: scoreAction(target, world, action, depth) }))
	const chosenScore = scores.find((entry) => entry.name === chosenName)?.score
	return scores.filter((entry) => entry.score === chosenScore && entry.name !== chosenName).map((entry) => entry.name)
}

async function run(request: RunRequest) {
	busyChannels.add(request.channel)
	try {
		await runSteps(request)
	} finally {
		if (isCurrent(request.channel, request.id)) busyChannels.delete(request.channel)
	}
}

async function runSteps(request: RunRequest) {
	const forced = new Map(request.forced)
	const foreseen = request.foresee ? forced : new Map<number, string>()
	// The time limit counts this run's own computing, not time spent waiting for other channels.
	let usedMs = 0
	let world: World = foreseen.size ? ({ ...request.start, __step: request.firstStepIndex } as World) : request.start
	let pending: Step[] = []
	let firstIndex = 0
	let lastPost = performance.now()
	const post = (done: boolean, isComplete: boolean) => {
		const response: WorkerResponse = { type: "run", channel: request.channel, id: request.id, firstIndex, steps: pending, done, isComplete }
		postMessage(response)
		firstIndex += pending.length
		pending = []
		lastPost = performance.now()
	}
	for (let offset = 0; offset < request.stepCount; offset++) {
		await waitForTurn(request.channel)
		if (!isCurrent(request.channel, request.id)) return
		const stepStart = performance.now()
		try {
			const step = withTimeLimit(Math.max(1, request.limitMs - usedMs), () => withForesight(foreseen, takeStep, () => {
				const actor = actors[world.turn]
				const forcedAction = availableActions(actor, world).find((action) => action.name === forced.get(request.firstStepIndex + offset))
				const chosenAction = forcedAction ?? chooseAction(actor, world, actor.searchDepth(world))
				const worldAfter = takeStep(world, chosenAction)
				const step: Step = { worldBefore: world, worldAfter, actorName: actor.name, chosenActionName: chosenAction.name }
				if (forcedAction) step.isForced = true
				else step.tiedWith = tiedWith(world, chosenAction.name)
				return step
			}))
			pending.push(step)
			world = step.worldAfter
			usedMs += performance.now() - stepStart
		} catch (error) {
			if (!(error instanceof TimeLimitReached)) throw error
			return post(true, false)
		}
		// Stream results about every 50ms; between steps, let newer requests in.
		if (performance.now() - lastPost > 50) post(false, false)
		await yieldToMessages()
	}
	post(true, true)
}

async function sweep(request: SweepRequest) {
	busyChannels.add(request.channel)
	try {
		await sweepCells(request)
	} finally {
		if (isCurrent(request.channel, request.id)) busyChannels.delete(request.channel)
	}
}

async function sweepCells(request: SweepRequest) {
	const startTime = performance.now()
	let cells: SweepCellResult[] = []
	let lastPost = performance.now()
	for (const job of request.jobs) {
		await waitForTurn(request.channel)
		if (!isCurrent(request.channel, request.id)) return
		const steps: Step[] = []
		let isComplete = true
		let world = job.start
		try {
			withTimeLimit(request.cellLimitMs, () => {
				for (let stepNumber = 1; stepNumber <= job.stepCount; stepNumber++) {
					const actor = actors[world.turn]
					const action = chooseAction(actor, world, actor.searchDepth(world))
					const worldAfter = takeStep(world, action)
					steps.push({ worldBefore: world, worldAfter, actorName: actor.name, chosenActionName: action.name })
					world = worldAfter
				}
			})
		} catch (error) {
			if (!(error instanceof TimeLimitReached)) throw error
			isComplete = false
		}
		const deployedIndex = steps.findIndex((step) => step.worldAfter.isDeployed)
		cells.push({ x: job.x, y: job.y, finalWorld: steps.at(-1)?.worldAfter ?? job.start, deployedAtStep: deployedIndex >= 0 ? deployedIndex + 1 : null, isComplete })
		if (performance.now() - lastPost > 50) {
			postMessage({ type: "sweep", channel: request.channel, id: request.id, cells, done: false, milliseconds: performance.now() - startTime } satisfies WorkerResponse)
			cells = []
			lastPost = performance.now()
		}
		await yieldToMessages()
	}
	postMessage({ type: "sweep", channel: request.channel, id: request.id, cells, done: true, milliseconds: performance.now() - startTime } satisfies WorkerResponse)
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
	const request = event.data
	latestIdByChannel.set(request.channel, request.id)
	void (request.type === "run" ? run(request) : sweep(request))
}
