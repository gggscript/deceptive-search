// Receives every call to a core function (via the wrapper from viz/instrument.ts) and either
// 1. records it, while `recordCalls` is running and the call is shallow enough, or
// 2. caches it, for `chooseAction`. All core functions are pure, so a cached result is exact.
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

const recordingStack: CallNode[] = []
let recordingLevels = 0

const CACHED_FUNCTIONS = new Set(["chooseAction"])
const cache = new Map<string, unknown>()

// Actors and actions are identified by name; worlds by their field values.
function cacheKey(functionName: string, argumentValues: unknown[]) {
	const parts = argumentValues.map((value) => {
		if (!value || typeof value !== "object") return String(value)
		if ("name" in value) return String(value.name)
		return Object.values(value).join(",")
	})
	return `${functionName}|${parts.join("|")}`
}

type Untraced = (...argumentValues: unknown[]) => unknown

;(globalThis as { __instrument?: unknown }).__instrument = {
	call(functionName: string, parameterNames: string[], argumentValues: unknown[], untraced: Untraced, traced: Untraced) {
		const isRecording = recordingStack.length > 0 && recordingStack.length <= recordingLevels
		if (isRecording) {
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
		}
		if (!CACHED_FUNCTIONS.has(functionName)) return untraced(...argumentValues)
		const key = cacheKey(functionName, argumentValues)
		if (cache.has(key)) return cache.get(key)
		const result = untraced(...argumentValues)
		cache.set(key, result)
		return result
	},
}

/** Runs `run` and returns the first core call it made, recorded `levels` calls deep. */
export function recordCalls(levels: number, run: () => unknown): CallNode {
	const root: CallNode = { functionName: "root", parameterNames: [], argumentValues: [], result: undefined, children: [], rerun: run }
	recordingStack.push(root)
	recordingLevels = levels
	try {
		run()
	} finally {
		recordingStack.pop()
	}
	return root.children![0]!
}

export function cacheSize() {
	return cache.size
}
