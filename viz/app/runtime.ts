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

function descend(level: CacheLevel, key: unknown) {
	let next = level.get(key) as CacheLevel | undefined
	if (!next) level.set(key, (next = new Map()))
	return next
}

function callCached(functionName: string, untraced: AnyFunction, argumentValues: unknown[]) {
	let level = cacheByFunction.get(functionName)
	if (!level) cacheByFunction.set(functionName, (level = new Map()))
	for (const value of argumentValues) {
		// Plain objects (worlds) contribute each field; everything else (numbers, actors, actions) is a key itself.
		if (value !== null && typeof value === "object" && !("name" in value)) {
			for (const field in value) level = descend(level, (value as Record<string, unknown>)[field])
		} else level = descend(level, value)
	}
	if (level.has(RESULT)) return level.get(RESULT)
	const result = untraced(...argumentValues)
	level.set(RESULT, result)
	cacheEntryCount++
	return result
}

const instrument = {
	isRecording: false,
	callCached,
	callWhileRecording(functionName: string, parameterNames: string[], argumentValues: unknown[], untraced: AnyFunction, traced: AnyFunction, isCached: boolean) {
		if (recordingStack.length > recordingLevels) {
			// Deeper than we record: behave like the fast path.
			return isCached ? callCached(functionName, untraced, argumentValues) : untraced(...argumentValues)
		}
		const node: CallNode = {
			functionName,
			parameterNames,
			argumentValues,
			result: undefined,
			children: recordingStack.length < recordingLevels ? [] : null,
			rerun: () => traced(...argumentValues),
		}
		recordingStack.at(-1)!.children!.push(node)
		recordingStack.push(node)
		try {
			node.result = untraced(...argumentValues)
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
