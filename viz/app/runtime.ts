// Receives calls to core functions (via the wrappers from viz/instrument.ts) and
// 1. records them, while `recordCalls` is running and the call is shallow enough, and
// 2. caches the ones the plugin marks as cached. Core functions are pure, so a cached result is exact.
//    Without the cache, every extra search depth costs about 10× more time.
// Import this module before any core module.

export type CallNode = {
	functionName: string
	parameterNames: string[]
	argumentValues: unknown[]
	result: unknown
	children: CallNode[] | null // null = not recorded (deeper than the recording went)
	rerun: () => unknown
}

type AnyFunction = (...argumentValues: any[]) => unknown

const recordingStack: CallNode[] = []
let recordingLevels = 0
// One tree of nested Maps per function, one level per value: actor (by identity), each world
// field, search depth. Looking up primitives in Maps is much faster than building string keys.
type CacheLevel = Map<unknown, CacheLevel | unknown>
const cacheByFunction = new Map<string, CacheLevel>()
const RESULT = Symbol("result")
let cacheEntryCount = 0

// A time limit, so a too-deep search stops instead of freezing the page.
// Checked every 1024 core calls; performance.now() is too slow to call every time.
export class TimeLimitReached extends Error {}
let deadline = Infinity
let callsUntilCheck = 1024
function checkDeadline() {
	if (--callsUntilCheck > 0) return
	callsUntilCheck = 1024
	if (performance.now() > deadline) throw new TimeLimitReached()
}

/** Runs `run`, throwing TimeLimitReached from inside the search once `milliseconds` have passed. */
export function withTimeLimit<T>(milliseconds: number, run: () => T): T {
	const previousDeadline = deadline
	deadline = Math.min(previousDeadline, performance.now() + milliseconds)
	try {
		return run()
	} finally {
		deadline = previousDeadline
	}
}

function descend(level: CacheLevel, key: unknown) {
	let next = level.get(key) as CacheLevel | undefined
	if (!next) level.set(key, (next = new Map()))
	return next
}

function callCached(functionName: string, untraced: AnyFunction, argumentValues: unknown[]) {
	checkDeadline()
	let level = cacheByFunction.get(functionName)
	if (!level) cacheByFunction.set(functionName, (level = new Map()))
	// With foreseen forced actions, a result depends only on the forced steps within the search's horizon,
	// relative to the world's step. Keying by those (not by the absolute step) lets distant steps share entries.
	if (foreseenKey) level = descend(level, forcedInView(argumentValues))
	// A search of depth d can't see a deployment more than d steps away, so any countdown above d gives the same
	// result: capping it lets steps that don't see the deployment coming share entries.
	const depth = argumentValues.findLast((value) => typeof value === "number") as number | undefined
	for (const value of argumentValues) {
		// Plain objects (worlds) contribute each field; everything else (numbers, actors, actions) is a key itself.
		if (value !== null && typeof value === "object" && !("name" in value)) {
			for (const field in value) {
				if (field === "__step") continue
				let fieldValue = (value as Record<string, unknown>)[field]
				if (field === "stepsUntilDeployment" && typeof fieldValue === "number" && depth !== undefined) fieldValue = Math.min(fieldValue, depth + 1)
				level = descend(level, fieldValue)
			}
		} else level = descend(level, value)
	}
	if (level.has(RESULT)) return level.get(RESULT)
	const result = untraced(...argumentValues)
	level.set(RESULT, result)
	cacheEntryCount++
	return result
}

// Forced actions that every search foresees. Worlds carry a hidden step counter (__step) so a prediction
// knows which step it is about: takeStep increments it, and chooseAction returns the forced action at a forced step.
type Hook = (functionName: string, argumentValues: unknown[]) => { value: unknown } | undefined
type ForesightActor = { name: string; actions: { name: string }[] }
let foreseenForced: ReadonlyMap<number, string> = new Map()
let foreseenKey = "" // foreseenForced as a string, for the cache

function foresightHook(functionName: string, argumentValues: unknown[]): { value: unknown } | undefined {
	if (functionName === "chooseAction") {
		const [actor, world] = argumentValues as [ForesightActor, { __step?: number }]
		const forcedName = world.__step === undefined ? undefined : foreseenForced.get(world.__step)
		const action = forcedName === undefined ? undefined : actor.actions.find((candidate) => candidate.name === forcedName)
		return action ? { value: action } : undefined
	}
	if (functionName === "takeStep") {
		const [world] = argumentValues as [{ __step?: number }]
		if (world.__step === undefined) return undefined
		// Run takeStep itself without the hook and without recording it a second time.
		const wasRecording = instrument.isRecording
		instrument.hook = null
		instrument.isRecording = false
		try {
			const next = takeStepUntraced!(...argumentValues) as { __step?: number }
			return { value: { ...next, __step: world.__step + 1 } }
		} finally {
			instrument.hook = foresightHook
			instrument.isRecording = wasRecording
		}
	}
	return undefined
}

let takeStepUntraced: AnyFunction | null = null
/** While `run` runs, searches foresee `forced` (step index → action name) for worlds that carry __step. */
export function withForesight<T>(forced: ReadonlyMap<number, string>, takeStep: AnyFunction, run: () => T): T {
	if (!forced.size) return run()
	const previous = { forced: foreseenForced, hook: instrument.hook, takeStep: takeStepUntraced }
	const previousKey = foreseenKey
	foreseenForced = forced
	foreseenKey = [...forced].sort(([a], [b]) => a - b).map(([index, name]) => `${index}:${name}`).join(",")
	takeStepUntraced = takeStep
	instrument.hook = foresightHook
	try {
		return run()
	} finally {
		foreseenForced = previous.forced
		foreseenKey = previousKey
		instrument.hook = previous.hook
		takeStepUntraced = previous.takeStep
	}
}

// The forced steps a call can see: from its world's step up to its search depth (the last number argument) ahead.
function forcedInView(argumentValues: unknown[]) {
	const world = argumentValues.find((value) => value !== null && typeof value === "object" && "__step" in value) as { __step: number } | undefined
	const depth = argumentValues.findLast((value) => typeof value === "number") as number | undefined
	if (!world || depth === undefined) return foreseenKey
	const start = world.__step
	let key = ""
	for (const [index, name] of foreseenForced) if (index >= start && index < start + depth) key += `${index - start}:${name},`
	return key
}

// Re-running a recorded call (to record more of it) must foresee the same forced actions as the first run.
function rerunWithSameForesight(run: () => unknown) {
	const forced = foreseenForced, takeStep = takeStepUntraced
	return () => (forced.size && takeStep ? withForesight(forced, takeStep, run) : run())
}

const instrument = {
	hook: null as Hook | null,
	isRecording: false,
	callCached,
	callWhileRecording(functionName: string, parameterNames: string[], argumentValues: unknown[], untraced: AnyFunction, traced: AnyFunction, isCached: boolean) {
		checkDeadline()
		const hooked = instrument.hook?.(functionName, argumentValues)
		if (recordingStack.length > recordingLevels) {
			// Deeper than we record: behave like the fast path.
			if (hooked) return hooked.value
			return isCached ? callCached(functionName, untraced, argumentValues) : untraced(...argumentValues)
		}
		const node: CallNode = {
			functionName,
			parameterNames,
			argumentValues,
			result: undefined,
			children: recordingStack.length < recordingLevels ? [] : null,
			rerun: rerunWithSameForesight(() => traced(...argumentValues)),
		}
		recordingStack.at(-1)!.children!.push(node)
		recordingStack.push(node)
		try {
			node.result = hooked ? hooked.value : untraced(...argumentValues)
		} finally {
			recordingStack.pop()
		}
		return node.result
	},
}
;(globalThis as { __instrument?: unknown }).__instrument = instrument

/** Runs `run` and returns the first core call it made, recorded `levels` calls deep. */
export function recordCalls(levels: number, run: () => unknown): CallNode {
	const root: CallNode = { functionName: "root", parameterNames: [], argumentValues: [], result: undefined, children: [], rerun: run }
	const wasRecording = instrument.isRecording
	recordingStack.push(root)
	recordingLevels = levels
	instrument.isRecording = true
	try {
		run()
	} finally {
		recordingStack.pop()
		instrument.isRecording = wasRecording
	}
	return root.children![0]!
}

export function cacheSize() {
	return cacheEntryCount
}
