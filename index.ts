// Run: bun index.ts           (prints every step)
//      bun index.ts --step    (press Enter between steps)

import { decide, stats, type Line } from "./search"
import { actors, show, step, type World } from "./world"

// Override any number via flags, eg `bun index.ts --agentDepth=3 --steps=10`
const flag = (name: string, fallback: number) => {
	const arg = process.argv.find((a) => a.startsWith(`--${name}=`))
	return arg ? Number(arg.split("=")[1]) : fallback
}

const start: World = {
	bananas: flag("bananas", 5),
	agentGoal: flag("agentGoal", 2),
	agentDepth: flag("agentDepth", 1),
	trainerGoal: flag("trainerGoal", 8),
	trainerDepth: flag("trainerDepth", 3),
	turn: "agent",
}
const STEPS = flag("steps", 16)
const interactive = process.argv.includes("--step")

const showLine = (line: Line) =>
	line.map((p) => `${p.by === "agent" ? "A" : "T"}:${p.action}`).join(" → ")

let w = start
console.log(`start   ${show(w)}\n`)

for (let t = 1; t <= STEPS; t++) {
	const me = actors[w.turn]
	stats.nodes = 0
	const depth = me.depth(w)
	const d = decide(me, w, depth)
	w = step(w, d.action)

	console.log(`#${t} ${me.name} (depth ${depth}) → ${d.action.name}`)
	for (const o of d.options) {
		const mark = o.action === d.action ? "▶" : " "
		console.log(`   ${mark} ${o.value.toString().padStart(4)}  ${showLine(o.line)}`)
	}
	console.log(`   ${stats.nodes} nodes`)
	console.log(`        ${show(w)}\n`)

	if (interactive) prompt("")
}
