// A Bun plugin that wraps every function in core/*.ts when the module is loaded, without
// changing the files. The wrappers talk to `__instrument` (see app/runtime.ts), which can
// record calls (for the call tree) and cache them (for speed).
//
// `function foo(a, b) {` becomes `function foo__untraced(a, b) {` plus a new `function foo(a, b)`.
// Function declarations are hoisted, so internal (recursive) calls also go through the wrapper.

import type { BunPlugin } from "bun"

// Pure functions worth caching. Caching chooseAction alone turns the exponential search into
// roughly (distinct worlds × search depth) work.
const CACHED_FUNCTIONS = new Set(["chooseAction"])

export function instrumentSource(source: string) {
	const functionPattern = /^(export )?function (\w+)\(([^)]*)\)/gm
	const wrappers: string[] = []
	const renamedSource = source.replace(functionPattern, (_match, exportKeyword: string | undefined, functionName: string, parameters: string) => {
		const parameterNames = parameters
			.split(",")
			.map((parameter) => parameter.split(/[:=]/)[0]!.trim())
			.filter(Boolean)
		const argumentList = parameterNames.join(", ")
		const untraced = `${functionName}__untraced`
		// Fast path when nothing is being recorded: call directly (or through the cache).
		const fastPath = CACHED_FUNCTIONS.has(functionName)
			? `return __instrument.callCached(${JSON.stringify(functionName)}, ${untraced}, [${argumentList}])`
			: `return ${untraced}(${argumentList})`
		wrappers.push(`${exportKeyword ?? ""}function ${functionName}(${parameterNames.map((name) => `${name}: any`).join(", ")}): any {
	if (!__instrument.isRecording) {
		if (__instrument.hook) { const hooked = __instrument.hook(${JSON.stringify(functionName)}, [${argumentList}]); if (hooked) return hooked.value }
		${fastPath}
	}
	return __instrument.callWhileRecording(${JSON.stringify(functionName)}, ${JSON.stringify(parameterNames)}, [${argumentList}], ${untraced}, ${functionName}, ${CACHED_FUNCTIONS.has(functionName)})
}`)
		return `function ${untraced}(${parameters})`
	})
	return `declare const __instrument: any\n${renamedSource}\n${wrappers.join("\n")}\n`
}

export const instrumentCorePlugin: BunPlugin = {
	name: "instrument core/*.ts",
	setup(build) {
		build.onLoad({ filter: /core[\\/](search|world)\.ts$/ }, async ({ path }) => ({
			contents: instrumentSource(await Bun.file(path).text()),
			loader: "ts",
		}))
	},
}
