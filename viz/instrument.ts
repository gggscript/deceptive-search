// A Bun plugin that wraps every function in core/*.ts when the module is loaded, without
// changing the files. The wrapper hands each call to `__instrument.call` (see app/runtime.ts),
// which can cache it or record it.
//
// `function foo(a, b) {` becomes `function foo__untraced(a, b) {` plus a new `function foo`.
// Function declarations are hoisted, so internal (recursive) calls also go through the wrapper.

import type { BunPlugin } from "bun"

export function instrumentSource(source: string) {
	const functionPattern = /^(export )?function (\w+)\(([^)]*)\)/gm
	const wrappers: string[] = []
	const renamedSource = source.replace(functionPattern, (_match, exportKeyword: string | undefined, functionName: string, parameters: string) => {
		const parameterNames = parameters
			.split(",")
			.map((parameter) => parameter.split(/[:=]/)[0]!.trim())
			.filter(Boolean)
		wrappers.push(
			`${exportKeyword ?? ""}function ${functionName}(...argumentValues: any[]): any {
	return __instrument.call(${JSON.stringify(functionName)}, ${JSON.stringify(parameterNames)}, argumentValues, ${functionName}__untraced, ${functionName})
}`,
		)
		return `function ${functionName}__untraced(${parameters})`
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
