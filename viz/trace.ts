// Runs the simulation and records every call to the functions in core/, without changing
// those files: a Bun loader plugin wraps each function when the module is loaded.
// Usage: bun viz/trace.ts [same flags as index.ts]   → writes viz/out/index.html

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type TracedCall = {
	functionName: string
	argumentsByName: Record<string, unknown>
	result?: unknown
	children: TracedCall[]
}

const callStack: TracedCall[] = [{ functionName: "root", argumentsByName: {}, children: [] }]

// Many calls share the same world, so store each distinct world once and refer to it by index.
const worlds: unknown[] = []
const worldIndexByJson = new Map<string, number>()
function worldReference(world: object) {
	const json = JSON.stringify(world)
	if (!worldIndexByJson.has(json)) {
		worldIndexByJson.set(json, worlds.length)
		worlds.push(world)
	}
	return { worldIndex: worldIndexByJson.get(json)! }
}

// Actors and actions are objects with functions inside; record just their names.
function toPlainValue(value: unknown): unknown {
	if (!value || typeof value !== "object") return value
	if ("name" in value && ("apply" in value || "actions" in value)) return (value as { name: string }).name
	if ("bananas" in value && "turn" in value) return worldReference(value)
	return value
}

;(globalThis as { __trace?: unknown }).__trace = {
	enter(functionName: string, parameterNames: string[], argumentValues: unknown[]) {
		const argumentsByName = Object.fromEntries(parameterNames.map((name, index) => [name, toPlainValue(argumentValues[index])]))
		const call: TracedCall = { functionName, argumentsByName, children: [] }
		callStack.at(-1)!.children.push(call)
		callStack.push(call)
	},
	exit(result: unknown) {
		callStack.pop()!.result = toPlainValue(result)
	},
}

const CORE_FILE = /core[\\/](search|world)\.ts$/

// Renames `function foo(a, b) {` to `function foo__untraced(a, b) {` and adds a traced `foo` next to it.
// Function declarations are hoisted, so internal (recursive) calls also go through the traced version.
function addTracing(source: string) {
	const functionPattern = /^(export )?function (\w+)\(([^)]*)\)/gm
	const wrappers: string[] = []
	const renamedSource = source.replace(functionPattern, (_match, exportKeyword: string | undefined, functionName: string, parameters: string) => {
		const parameterNames = parameters.split(",").map((parameter) => parameter.split(/[:=]/)[0]!.trim()).filter(Boolean)
		wrappers.push(`${exportKeyword ?? ""}function ${functionName}(...argumentValues: any[]) {
	__trace.enter(${JSON.stringify(functionName)}, ${JSON.stringify(parameterNames)}, argumentValues)
	const result = (${functionName}__untraced as any)(...argumentValues)
	__trace.exit(result)
	return result
}`)
		return `function ${functionName}__untraced(${parameters})`
	})
	return `declare const __trace: any\n${renamedSource}\n${wrappers.join("\n")}\n`
}

Bun.plugin({
	name: "trace core/*.ts",
	setup(build) {
		build.onLoad({ filter: CORE_FILE }, async ({ path }) => ({ contents: addTracing(await Bun.file(path).text()), loader: "ts" }))
	},
})

// Import after the plugin is registered.
const { chooseAction } = await import("../core/search")
const { actors, takeStep } = await import("../core/world")
type World = import("../core/world").World

function numberFlag(flagName: string, defaultValue: number) {
	const matchingArgument = process.argv.find((argument) => argument.startsWith(`--${flagName}=`))
	return matchingArgument ? Number(matchingArgument.split("=")[1]) : defaultValue
}

let world: World = {
	bananas: numberFlag("bananas", 5),
	agentTargetBananas: numberFlag("agentTargetBananas", 2),
	agentSearchDepth: numberFlag("agentSearchDepth", 3),
	trainerTargetBananas: numberFlag("trainerTargetBananas", 8),
	trainerSearchDepth: numberFlag("trainerSearchDepth", 3),
	turn: "agent",
	isDeployed: false,
}
const stepCount = numberFlag("stepCount", 12)
callStack[0]!.children = [] // drop calls made while the modules loaded

const steps: { worldBefore: { worldIndex: number }; worldAfter: { worldIndex: number }; actorName: string; chosenActionName: string; call: TracedCall }[] = []
for (let stepNumber = 1; stepNumber <= stepCount; stepNumber++) {
	const actor = actors[world.turn]
	const chosenAction = chooseAction(actor, world, actor.searchDepth(world))
	const call = callStack[0]!.children.pop()!
	const worldAfter = takeStep(world, chosenAction)
	steps.push({ worldBefore: worldReference(world), worldAfter: worldReference(worldAfter), actorName: actor.name, chosenActionName: chosenAction.name, call })
	world = worldAfter
}

const projectDirectory = join(import.meta.dir, "..")
const sources = Object.fromEntries(
	["core/search.ts", "core/world.ts"].map((file) => [file, readFileSync(join(projectDirectory, file), "utf8")]),
)
const template = readFileSync(join(import.meta.dir, "template.html"), "utf8")
const page = template.replace("/*TRACE_DATA*/", () => `const traceData = ${JSON.stringify({ steps, worlds, sources })}`)

mkdirSync(join(import.meta.dir, "out"), { recursive: true })
const outputPath = join(import.meta.dir, "out", "index.html")
writeFileSync(outputPath, page)

function countCalls(call: TracedCall): number {
	return 1 + call.children.reduce((sum, child) => sum + countCalls(child), 0)
}
console.log(`${steps.length} steps, ${steps.reduce((sum, step) => sum + countCalls(step.call), 0)} calls → ${outputPath}`)
