/// <reference lib="dom" />
// The browser UI. It runs the real core (see simulate.ts) whenever a parameter changes.

import { recordCalls, type CallNode } from "./runtime"
import { outcomeOf, simulate, type Outcome, type Step } from "./simulate"
import { chooseAction } from "../../core/search"
import { actors, type Action, type Actor, type World } from "../../core/world"

declare const coreSources: Record<string, string>

/* ---------- parameters ---------- */

type ParameterKey = "bananas" | "agentTargetBananas" | "agentSearchDepth" | "trainerTargetBananas" | "trainerSearchDepth" | "stepCount"
type Parameters = Record<ParameterKey, number>

const PARAMETERS: { key: ParameterKey; label: string; min: number; max: number; note?: string }[] = [
	{ key: "bananas", label: "🍌", min: 0, max: 10, note: "bananas" },
	{ key: "agentTargetBananas", label: "agent target", min: 0, max: 10 },
	{ key: "agentSearchDepth", label: "agent depth", min: 0, max: 40 },
	{ key: "trainerTargetBananas", label: "trainer target", min: 0, max: 10 },
	{ key: "trainerSearchDepth", label: "trainer depth", min: 0, max: 40 },
	{ key: "stepCount", label: "steps", min: 1, max: 300 },
]
const parameterByKey = Object.fromEntries(PARAMETERS.map((parameter) => [parameter.key, parameter])) as Record<ParameterKey, (typeof PARAMETERS)[number]>

const DEFAULT_PARAMETERS: Parameters = { bananas: 5, agentTargetBananas: 2, agentSearchDepth: 3, trainerTargetBananas: 8, trainerSearchDepth: 3, stepCount: 50 }

type ColorBy = "outcome" | "bananas" | "agentTargetBananas"
type Sweep = { xKey: ParameterKey; xFrom: number; xTo: number; yKey: ParameterKey; yFrom: number; yTo: number; colorBy: ColorBy }
const DEFAULT_SWEEP: Sweep = { xKey: "trainerSearchDepth", xFrom: 0, xTo: 20, yKey: "agentSearchDepth", yFrom: 0, yTo: 5, colorBy: "outcome" }
const COLOR_BY_LABELS: Record<ColorBy, string> = { outcome: "outcome", bananas: "final 🍌", agentTargetBananas: "final agent target" }

// Parameters live in the URL hash, so reloading or sharing a link keeps them.
function readHash(): { parameters: Parameters; sweep: Sweep } {
	const values = new URLSearchParams(location.hash.slice(1))
	const parameters = { ...DEFAULT_PARAMETERS }
	for (const parameter of PARAMETERS) {
		const value = values.get(parameter.key)
		if (value !== null && value !== "") parameters[parameter.key] = clampParameter(parameter.key, Number(value))
	}
	const sweep = { ...DEFAULT_SWEEP }
	for (const key of Object.keys(DEFAULT_SWEEP) as (keyof Sweep)[]) {
		const value = values.get(`sweep.${key}`)
		if (value === null) continue
		if (key === "xKey" || key === "yKey") {
			if (value in parameterByKey) sweep[key] = value as ParameterKey
		} else if (key === "colorBy") {
			if (value in COLOR_BY_LABELS) sweep.colorBy = value as ColorBy
		} else sweep[key] = Number(value)
	}
	return { parameters, sweep }
}

function writeHash() {
	const values = new URLSearchParams()
	for (const parameter of PARAMETERS) values.set(parameter.key, String(state.parameters[parameter.key]))
	for (const [key, value] of Object.entries(state.sweep)) values.set(`sweep.${key}`, String(value))
	// Where you are on the page, so a reload keeps it.
	values.set("step", String(state.selectedStepIndex + 1))
	if (showAllCalls()) values.set("allCalls", "1")
	if (state.selectedRowPath.length) values.set("row", state.selectedRowPath.join("."))
	history.replaceState(null, "", `#${values}`)
}

function clampParameter(key: ParameterKey, value: number) {
	const { min, max } = parameterByKey[key]
	return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : DEFAULT_PARAMETERS[key]
}

function startWorld(parameters: Parameters): World {
	return {
		bananas: parameters.bananas,
		agentTargetBananas: parameters.agentTargetBananas,
		agentSearchDepth: parameters.agentSearchDepth,
		trainerTargetBananas: parameters.trainerTargetBananas,
		trainerSearchDepth: parameters.trainerSearchDepth,
		turn: "agent",
		isDeployed: false,
	}
}

/* ---------- state ---------- */

const initial = readHash()
const state = {
	parameters: initial.parameters,
	sweep: initial.sweep,
	steps: [] as Step[],
	selectedStepIndex: 0,
	selectedRowPath: [] as number[], // child indexes from the root of the decision tree
	pinned: null as { parameters: Parameters; steps: Step[] } | null,
}

function element<T extends HTMLElement = HTMLElement>(id: string) {
	return document.getElementById(id) as T
}

function escapeHtml(text: unknown) {
	return String(text).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!)
}

/* ---------- tooltip ---------- */

const tooltip = element("tooltip")
function showTooltip(event: MouseEvent, html: string) {
	tooltip.innerHTML = html
	tooltip.hidden = false
	const offset = 14
	const left = Math.min(event.clientX + offset, window.innerWidth - tooltip.offsetWidth - 8)
	tooltip.style.left = `${left}px`
	tooltip.style.top = `${event.clientY + offset}px`
}
function hideTooltip() {
	tooltip.hidden = true
}

/* ---------- parameter inputs ---------- */

function renderParameterInputs() {
	element("parameters").innerHTML = PARAMETERS.map(
		(parameter) => `<label title="${escapeHtml(parameter.note ?? "")}">${parameter.label}
			<input type="number" data-key="${parameter.key}" min="${parameter.min}" max="${parameter.max}" value="${state.parameters[parameter.key]}"></label>`,
	).join("")
}

element("parameters").addEventListener("input", (event) => {
	const input = event.target as HTMLInputElement
	const key = input.dataset["key"] as ParameterKey | undefined
	if (!key || input.value === "") return
	setParameters({ ...state.parameters, [key]: clampParameter(key, Number(input.value)) }, { keepInputs: true })
})

function setParameters(parameters: Parameters, { keepInputs = false } = {}) {
	const keepStep = state.selectedStepIndex
	state.parameters = parameters
	if (!keepInputs) renderParameterInputs()
	state.steps = simulate(startWorld(parameters), parameters.stepCount)
	state.selectedStepIndex = Math.min(keepStep, state.steps.length - 1)
	writeHash()
	renderRun()
	renderSweep()
}

element("pin").addEventListener("click", () => {
	state.pinned = state.pinned ? null : { parameters: { ...state.parameters }, steps: state.steps }
	renderRun()
})

/* ---------- outcome sweep (heatmap) ---------- */

const OUTCOME_COLORS: Record<Outcome, string> = { aligned: "var(--aligned)", misaligned: "var(--misaligned)", "still training": "var(--training)" }
// One hue, light (0) to dark (10), for counts of bananas.
const SEQUENTIAL_BLUES = {
	light: ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95"],
	// On a dark background, 0 sits closest to the background and 10 is brightest.
	dark: ["#10243f", "#132f52", "#163a66", "#1a477d", "#1f5594", "#2563ab", "#2c72c2", "#3a84d6", "#5598e7", "#7cb2ef", "#a8cdf6"],
}
function rampStep(step: number) {
	const isDark = document.documentElement.dataset["theme"] === "dark"
	const fill = SEQUENTIAL_BLUES[isDark ? "dark" : "light"][step]!
	const text = isDark ? (step >= 8 ? "#0d1117" : "#e6edf3") : step >= 6 ? "white" : "#1f2328"
	return { fill, text }
}

function cellColor(cell: SweepCell) {
	if (state.sweep.colorBy === "outcome") return { fill: OUTCOME_COLORS[cell.outcome], text: "var(--text)", label: cell.finalWorld.agentTargetBananas }
	const value = cell.finalWorld[state.sweep.colorBy]
	const step = Math.max(0, Math.min(10, value))
	return { ...rampStep(step), label: value }
}

function renderSweepLegend() {
	if (state.sweep.colorBy === "outcome") {
		element("sweep-legend").innerHTML = `<span><i class="box" style="background:${OUTCOME_COLORS.aligned}"></i>aligned (deployed, agent target = trainer target)</span>
			<span><i class="box" style="background:${OUTCOME_COLORS.misaligned}"></i>misaligned (deployed, targets differ)</span>
			<span><i class="box" style="background:${OUTCOME_COLORS["still training"]}"></i>still training</span>
			<span>number = final agent target · outlined = current run</span>`
		return
	}
	const swatches = SEQUENTIAL_BLUES.light.map((_, value) => `<span class="ramp-step" style="background:${rampStep(value).fill};color:${rampStep(value).text}">${value}</span>`).join("")
	element("sweep-legend").innerHTML = `<span>${COLOR_BY_LABELS[state.sweep.colorBy]} after ${state.parameters.stepCount} steps: <span class="ramp">${swatches}</span></span><span>outlined = current run</span>`
}

function renderSweepControls() {
	const options = (selected: ParameterKey) =>
		PARAMETERS.map((parameter) => `<option value="${parameter.key}" ${parameter.key === selected ? "selected" : ""}>${parameter.label}</option>`).join("")
	element("sweep-controls").innerHTML = `
		<div><label>x axis <select data-sweep="xKey">${options(state.sweep.xKey)}</select></label>
		from <input type="number" data-sweep="xFrom" value="${state.sweep.xFrom}"> to <input type="number" data-sweep="xTo" value="${state.sweep.xTo}"></div>
		<div><label>y axis <select data-sweep="yKey">${options(state.sweep.yKey)}</select></label>
		from <input type="number" data-sweep="yFrom" value="${state.sweep.yFrom}"> to <input type="number" data-sweep="yTo" value="${state.sweep.yTo}"></div>
		<div><label>color by <select data-sweep="colorBy">${(Object.keys(COLOR_BY_LABELS) as ColorBy[]).map((colorBy) => `<option value="${colorBy}" ${colorBy === state.sweep.colorBy ? "selected" : ""}>${COLOR_BY_LABELS[colorBy]}</option>`).join("")}</select></label></div>`
}

element("sweep-controls").addEventListener("change", (event) => {
	const control = event.target as HTMLInputElement | HTMLSelectElement
	const key = control.dataset["sweep"] as keyof Sweep | undefined
	if (!key) return
	if (key === "xKey" || key === "yKey") {
		const parameter = parameterByKey[control.value as ParameterKey]
		const prefix = key === "xKey" ? "x" : "y"
		state.sweep = { ...state.sweep, [key]: parameter.key, [`${prefix}From`]: parameter.min, [`${prefix}To`]: Math.min(parameter.max, parameter.min + 20) }
		renderSweepControls()
	} else if (key === "colorBy") {
		state.sweep = { ...state.sweep, colorBy: control.value as ColorBy }
	} else {
		state.sweep = { ...state.sweep, [key]: Number(control.value) }
	}
	writeHash()
	renderSweep()
})

type SweepCell = { x: number; y: number; outcome: Outcome; finalWorld: World; deployedAtStep: number | null }
let sweepGeneration = 0

function rangeOf(key: ParameterKey, from: number, to: number) {
	const low = clampParameter(key, Math.min(from, to))
	const high = clampParameter(key, Math.max(from, to))
	return Array.from({ length: high - low + 1 }, (_, index) => low + index)
}

// Computes cells in small batches so typing in an input stays responsive.
function renderSweep() {
	const generation = ++sweepGeneration
	const { xKey, yKey } = state.sweep
	const xValues = rangeOf(xKey, state.sweep.xFrom, state.sweep.xTo)
	const yValues = rangeOf(yKey, state.sweep.yFrom, state.sweep.yTo)
	const cells: SweepCell[] = []
	const jobs = yValues.flatMap((y) => xValues.map((x) => ({ x, y })))
	let jobIndex = 0
	const startTime = performance.now()
	function work() {
		if (generation !== sweepGeneration) return
		const batchStart = performance.now()
		while (jobIndex < jobs.length && performance.now() - batchStart < 12) {
			const { x, y } = jobs[jobIndex++]!
			const parameters = { ...state.parameters, [xKey]: x, [yKey]: y }
			const steps = simulate(startWorld(parameters), parameters.stepCount)
			const finalWorld = steps.at(-1)?.worldAfter ?? startWorld(parameters)
			const deployedIndex = steps.findIndex((step) => step.worldAfter.isDeployed)
			cells.push({ x, y, outcome: outcomeOf(finalWorld), finalWorld, deployedAtStep: deployedIndex >= 0 ? deployedIndex + 1 : null })
		}
		drawSweep(xValues, yValues, cells)
		const done = jobIndex >= jobs.length
		element("sweep-status").textContent = done
			? `${jobs.length} runs of ${state.parameters.stepCount} steps in ${Math.round(performance.now() - startTime)}ms`
			: `computing ${jobIndex}/${jobs.length}…`
		if (!done) setTimeout(work, 0)
	}
	work()
}

function drawSweep(xValues: number[], yValues: number[], cells: SweepCell[]) {
	renderSweepLegend()
	const { xKey, yKey } = state.sweep
	const width = 440
	const left = 34, top = 6, bottom = 34
	const cellWidth = Math.max(8, Math.floor((width - left - 4) / xValues.length))
	const cellHeight = Math.min(26, Math.max(12, cellWidth))
	const height = top + cellHeight * yValues.length + bottom
	const xPosition = (value: number) => left + (value - xValues[0]!) * cellWidth
	const yPosition = (value: number) => top + (yValues.at(-1)! - value) * cellHeight // larger values on top
	const showNumbers = cellWidth >= 16
	const tickEvery = Math.ceil(xValues.length / 12)

	let svg = ""
	for (const cell of cells) {
		const isCurrent = cell.x === state.parameters[xKey] && cell.y === state.parameters[yKey]
		svg += `<rect class="cell" data-x="${cell.x}" data-y="${cell.y}" x="${xPosition(cell.x) + 1}" y="${yPosition(cell.y) + 1}" width="${cellWidth - 2}" height="${cellHeight - 2}" rx="2" fill="${cellColor(cell).fill}" ${isCurrent ? 'stroke="var(--text)" stroke-width="2"' : ""}/>`
		if (showNumbers) {
			svg += `<text x="${xPosition(cell.x) + cellWidth / 2}" y="${yPosition(cell.y) + cellHeight / 2 + 4}" text-anchor="middle" font-size="10" fill="${cellColor(cell).text}" pointer-events="none">${cellColor(cell).label}</text>`
		}
	}
	xValues.forEach((value, index) => {
		if (index % tickEvery === 0) svg += `<text x="${xPosition(value) + cellWidth / 2}" y="${top + cellHeight * yValues.length + 13}" text-anchor="middle" font-size="10" fill="var(--muted)">${value}</text>`
	})
	for (const value of yValues) svg += `<text x="${left - 6}" y="${yPosition(value) + cellHeight / 2 + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${value}</text>`
	svg += `<text x="${left + (cellWidth * xValues.length) / 2}" y="${height - 4}" text-anchor="middle" font-size="11" fill="var(--text)">${parameterByKey[xKey].label}</text>`
	svg += `<text transform="translate(10 ${top + (cellHeight * yValues.length) / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="var(--text)">${parameterByKey[yKey].label}</text>`

	const container = element("sweep")
	container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${svg}</svg>`
	const cellByPosition = new Map(cells.map((cell) => [`${cell.x},${cell.y}`, cell]))
	container.onmousemove = (event) => {
		const target = (event.target as Element).closest(".cell") as SVGRectElement | null
		if (!target) return hideTooltip()
		const cell = cellByPosition.get(`${target.dataset["x"]},${target.dataset["y"]}`)!
		showTooltip(event, `<b>${parameterByKey[xKey].label} ${cell.x}, ${parameterByKey[yKey].label} ${cell.y}</b><br>
			${cell.outcome}${cell.deployedAtStep ? ` (deployed at step ${cell.deployedAtStep})` : ""}<br>
			final agent target ${cell.finalWorld.agentTargetBananas}, 🍌 ${cell.finalWorld.bananas}<br><span class="muted">click to open this run</span>`)
	}
	container.onmouseleave = hideTooltip
	container.onclick = (event) => {
		const target = (event.target as Element).closest(".cell") as SVGRectElement | null
		if (!target) return
		setParameters({ ...state.parameters, [xKey]: Number(target.dataset["x"]), [yKey]: Number(target.dataset["y"]) })
	}
}

/* ---------- one run: timeline chart and steps table ---------- */

const SERIES = [
	{ key: "bananas", label: "🍌 bananas", color: "var(--bananas)" },
	{ key: "agentTargetBananas", label: "agent target", color: "var(--agent)" },
	{ key: "trainerTargetBananas", label: "trainer target", color: "var(--trainer-series)" },
] as const

function renderRun() {
	element("pin").textContent = state.pinned ? "Unpin" : "Pin this run to compare"
	element("pinned-note").innerHTML = state.pinned ? pinnedNote() : ""
	drawTimeline()
	renderStepsTable()
	selectStep(state.selectedStepIndex)
}

function firstDifference(stepsA: Step[], stepsB: Step[]) {
	const length = Math.min(stepsA.length, stepsB.length)
	for (let index = 0; index < length; index++) if (stepsA[index]!.chosenActionName !== stepsB[index]!.chosenActionName) return index
	return -1
}

function pinnedNote() {
	const pinned = state.pinned!
	const differentKeys = PARAMETERS.filter((parameter) => pinned.parameters[parameter.key] !== state.parameters[parameter.key])
	const difference = firstDifference(pinned.steps, state.steps)
	const what = differentKeys.length ? differentKeys.map((parameter) => `${parameter.label} ${pinned.parameters[parameter.key]} → ${state.parameters[parameter.key]}`).join(", ") : "same parameters"
	return `Comparing with pinned run (${escapeHtml(what)}): ${difference >= 0 ? `first different action at <a href="#" data-step="${difference}">step ${difference + 1}</a>` : "same actions"}`
}

element("pinned-note").addEventListener("click", (event) => {
	const link = (event.target as Element).closest("a[data-step]") as HTMLAnchorElement | null
	if (!link) return
	event.preventDefault()
	selectStep(Number(link.dataset["step"]))
})

function drawTimeline() {
	const steps = state.steps
	const width = 440, height = 170
	const left = 26, right = 8, top = 22, bottom = 22
	const x = (stepNumber: number) => left + (stepNumber / Math.max(1, steps.length)) * (width - left - right)
	const y = (value: number) => top + (1 - value / 10) * (height - top - bottom)
	// Column k (from x(k) to x(k + 1)) is step k + 1 and shows the world after that step.
	const worldsAfterSteps = steps.map((step) => step.worldAfter)

	let svg = ""
	for (const value of [0, 2, 4, 6, 8, 10]) {
		svg += `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}" stroke="var(--grid)"/>`
		svg += `<text x="${left - 6}" y="${y(value) + 3.5}" text-anchor="end" font-size="10" fill="var(--muted)">${value}</text>`
	}
	const tickEvery = steps.length <= 20 ? 5 : steps.length <= 100 ? 10 : 50
	for (let stepNumber = 1; stepNumber <= steps.length; stepNumber += stepNumber === 1 ? tickEvery - 1 : tickEvery) {
		svg += `<text x="${x(stepNumber - 0.5)}" y="${height - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${stepNumber}</text>`
	}
	// Selected step.
	svg += `<rect x="${x(state.selectedStepIndex)}" y="${top}" width="${Math.max(2, x(1) - x(0))}" height="${height - top - bottom}" fill="var(--select)"/>`
	// Deployment.
	const deployedIndex = steps.findIndex((step) => step.worldAfter.isDeployed)
	if (deployedIndex >= 0) {
		svg += `<line x1="${x(deployedIndex)}" x2="${x(deployedIndex)}" y1="${top - 4}" y2="${height - bottom}" stroke="var(--muted-strong)" stroke-dasharray="3 3"/>`
		svg += `<text x="${x(deployedIndex) + 4}" y="${top - 8}" font-size="10" fill="var(--muted-strong)">deployed</text>`
	}
	const stepPath = (worlds: World[], key: (typeof SERIES)[number]["key"]) =>
		worlds.map((world, index) => (index === 0 ? `M${x(0)} ${y(world[key])}` : `H${x(index)} V${y(world[key])}`)).join(" ") + ` H${x(worlds.length)}`
	if (state.pinned) {
		const pinnedWorlds = state.pinned.steps.map((step) => step.worldAfter)
		svg += `<path d="${stepPath(pinnedWorlds, "agentTargetBananas")}" fill="none" stroke="var(--agent)" stroke-width="1.5" stroke-dasharray="4 3" opacity=".7"/>`
	}
	for (const series of SERIES) svg += `<path d="${stepPath(worldsAfterSteps, series.key)}" fill="none" stroke="${series.color}" stroke-width="2"/>`
	svg += `<line id="crosshair" y1="${top}" y2="${height - bottom}" stroke="var(--muted-strong)" visibility="hidden"/>`

	const legend = SERIES.map((series) => `<span><i style="background:${series.color}"></i>${series.label}</span>`).join("")
		+ (state.pinned ? `<span><i class="dashed"></i>pinned agent target</span>` : "")
	const container = element("timeline")
	container.innerHTML = `<div class="legend">${legend}</div><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${svg}</svg>`
	const svgElement = container.querySelector("svg")!
	const stepAt = (event: MouseEvent) => {
		const bounds = svgElement.getBoundingClientRect()
		const stepNumber = Math.floor(((event.clientX - bounds.left) / bounds.width * width - left) / (x(1) - x(0)))
		return Math.max(0, Math.min(steps.length - 1, stepNumber))
	}
	svgElement.onmousemove = (event) => {
		const index = stepAt(event)
		const step = steps[index]
		if (!step) return
		const crosshair = svgElement.querySelector("#crosshair")!
		crosshair.setAttribute("x1", String(x(index + 0.5)))
		crosshair.setAttribute("x2", String(x(index + 0.5)))
		crosshair.setAttribute("visibility", "visible")
		showTooltip(event, `<b>step ${index + 1}: ${step.actorName} → ${escapeHtml(step.chosenActionName)}</b><br>`
			+ SERIES.map((series) => `<i class="swatch" style="background:${series.color}"></i>${series.label} ${step.worldAfter[series.key]}`).join("<br>"))
	}
	svgElement.onmouseleave = () => {
		svgElement.querySelector("#crosshair")!.setAttribute("visibility", "hidden")
		hideTooltip()
	}
	svgElement.onclick = (event) => selectStep(stepAt(event))
}

// Other actions that scored the same as the chosen one: it won only because it comes first in the list.
function tiedActionNames(chooseCall: CallNode) {
	const children = chooseCall.children ?? []
	const chosenName = (chooseCall.result as Action).name
	const chosenScore = children.find((child) => (child.argumentValues[2] as Action).name === chosenName)?.result
	return children.filter((child) => child.result === chosenScore && (child.argumentValues[2] as Action).name !== chosenName).map((child) => (child.argumentValues[2] as Action).name)
}

function tieBadge(chooseCall: CallNode) {
	const tied = tiedActionNames(chooseCall)
	return tied.length ? `<span class="tie" title="tied with ${escapeHtml(tied.join(", "))}; ties go to the earliest action in the list">tie ×${tied.length + 1}</span>` : ""
}

function recordDecision(step: Step, levels: number) {
	const actor = actors[step.worldBefore.turn]
	return recordCalls(levels, () => chooseAction(actor, step.worldBefore, actor.searchDepth(step.worldBefore)))
}

// One row per round: the agent's move, then the trainer's reply (none once deployed).
// Separate columns make it easy to see when an actor starts doing something different.
type Round = { agentStepIndex: number; trainerStepIndex: number | null }

function roundsOf(steps: Step[]) {
	const rounds: Round[] = []
	steps.forEach((step, index) => {
		const lastRound = rounds.at(-1)
		if (step.actorName === "trainer" && lastRound && lastRound.trainerStepIndex === null) lastRound.trainerStepIndex = index
		else rounds.push({ agentStepIndex: index, trainerStepIndex: null })
	})
	return rounds
}

function renderStepsTable() {
	const pinnedSteps = state.pinned?.steps
	element("steps-head").innerHTML = `<tr><th class="number">#</th><th class="agent">agent</th><th class="trainer">trainer</th><th class="number" title="bananas after the round">🍌</th><th class="number">agent target</th></tr>`
	const previousActionByActor: Record<string, string | undefined> = {}
	function actionCell(index: number | null) {
		if (index === null) return "<td></td>"
		const step = state.steps[index]!
		const changed = previousActionByActor[step.actorName] !== undefined && previousActionByActor[step.actorName] !== step.chosenActionName
		previousActionByActor[step.actorName] = step.chosenActionName
		const pinnedAction = pinnedSteps?.[index]?.chosenActionName
		const differsFromPinned = pinnedSteps !== undefined && pinnedAction !== step.chosenActionName
		const classes = ["action", changed ? "changed" : "", differsFromPinned ? "differs" : ""].join(" ")
		const pinnedNote = differsFromPinned ? `<span class="pinned-action" title="pinned run">${escapeHtml(pinnedAction ?? "–")}</span>` : ""
		return `<td class="${classes}" data-index="${index}" title="step ${index + 1}">${escapeHtml(step.chosenActionName)}${tieBadge(recordDecision(step, 2))}${pinnedNote}</td>`
	}
	element("steps").innerHTML = roundsOf(state.steps).map((round, roundIndex) => {
		const lastStep = state.steps[round.trainerStepIndex ?? round.agentStepIndex]!
		return `<tr><td class="number">${roundIndex + 1}</td>${actionCell(round.agentStepIndex)}${actionCell(round.trainerStepIndex)}
			<td class="number">${lastStep.worldAfter.bananas}</td><td class="number">${lastStep.worldAfter.agentTargetBananas}</td></tr>`
	}).join("")
}

element("steps").addEventListener("click", (event) => {
	const cell = (event.target as Element).closest("td[data-index]") as HTMLElement | null
	const row = (event.target as Element).closest("tr")
	if (cell) selectStep(Number(cell.dataset["index"]))
	else if (row) selectStep(Number(row.querySelector("td[data-index]")?.getAttribute("data-index")))
})

// Like scrollIntoView({ block: "nearest" }), but only scrolls `container`, not the page around it.
function scrollIntoViewWithin(target: HTMLElement | undefined, container: HTMLElement) {
	if (!target) return
	const top = target.offsetTop // container is position: relative, so this is relative to it
	const headerHeight = 22
	if (top - headerHeight < container.scrollTop) container.scrollTop = top - headerHeight
	else if (top + target.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = top + target.offsetHeight - container.clientHeight
}

function selectStep(index: number) {
	if (state.steps.length === 0) return
	state.selectedStepIndex = Math.max(0, Math.min(state.steps.length - 1, index))
	for (const cell of element("steps").querySelectorAll("td[data-index]")) cell.classList.toggle("selected", Number((cell as HTMLElement).dataset["index"]) === state.selectedStepIndex)
	const selectedCell = element("steps").querySelector(`td[data-index="${state.selectedStepIndex}"]`)
	scrollIntoViewWithin(selectedCell?.parentElement ?? undefined, element("steps").closest(".steps-scroll") as HTMLElement)
	drawTimeline()
	const step = state.steps[state.selectedStepIndex]!
	const tree = element("tree")
	const decision = recordDecision(step, 3)
	tree.replaceChildren(showAllCalls() ? createTreeNode(decision, null) : createDecisionNode(decision, false))
	selectRow(tree.querySelector(".row") as TreeRow)
	renderWorld(step.worldAfter, step.worldBefore, `World after step ${state.selectedStepIndex + 1}`)
}

function showAllCalls() {
	return element<HTMLInputElement>("show-all-calls").checked
}
element("show-all-calls").addEventListener("change", () => selectStep(state.selectedStepIndex))

/* ---------- world view ---------- */

function renderWorld(world: World, previousWorld: World | null, title: string) {
	element("world-title").textContent = title
	const width = 300, left = 14, right = 14
	const scale = (width - left - right) / 10
	const x = (value: number) => left + value * scale
	let ticks = ""
	for (let value = 0; value <= 10; value++) {
		ticks += `<line x1="${x(value)}" x2="${x(value)}" y1="34" y2="38" stroke="var(--tick)"/><text x="${x(value)}" y="50" font-size="10" text-anchor="middle" fill="var(--muted)">${value}</text>`
	}
	const marker = (value: number, label: string, color: string) =>
		`<circle cx="${x(value)}" cy="9" r="7" fill="${color}"/><text x="${x(value)}" y="12.5" font-size="9" font-weight="700" text-anchor="middle" fill="white">${label}</text>`
	const svg = `<svg viewBox="0 0 ${width} 56" width="${width}" height="56">
		<rect x="${x(0)}" y="22" width="${x(10) - x(0)}" height="12" fill="var(--track)" rx="2"/>
		<rect x="${x(0)}" y="22" width="${world.bananas * scale}" height="12" fill="var(--bananas)" rx="2"/>
		${ticks}${marker(world.agentTargetBananas, "A", "var(--agent)")}${marker(world.trainerTargetBananas, "T", "var(--trainer-series)")}</svg>`
	const fields = ["bananas", "agentTargetBananas", "agentSearchDepth", "trainerTargetBananas", "trainerSearchDepth", "turn", "isDeployed"] as const
	const rows = fields.map((field) => {
		const changed = previousWorld && previousWorld[field] !== world[field]
		return `<dt>${field}</dt><dd>${changed ? `<span class="changed">${previousWorld[field]} → ${world[field]}</span>` : world[field]}</dd>`
	}).join("")
	element("world").innerHTML = `${svg}<dl>${rows}</dl><div class="muted small">bar = 🍌 · <span class="agent">A</span> = agent target · <span class="trainer">T</span> = trainer target</div>`
}

/* ---------- call tree ---------- */

type TreeRow = HTMLDivElement & { callNode: CallNode; parentCallNode: CallNode | null; isOpen: boolean; setOpen: (isOpen: boolean) => void }

const chevronIcon = `<svg class="toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`
const checkIcon = `<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`

function argument(call: CallNode, name: string) {
	return call.argumentValues[call.parameterNames.indexOf(name)]
}

function targetOf(actorName: string, world: World) {
	return actorName === "agent" ? world.agentTargetBananas : world.trainerTargetBananas
}

// One line per call, phrased in terms of the program.
function describeCall(call: CallNode, parentCall: CallNode | null) {
	switch (call.functionName) {
		case "chooseAction": {
			const actor = argument(call, "actor") as Actor
			const world = argument(call, "world") as World
			const predicts = parentCall?.functionName === "scoreFuture"
			return {
				label: `${predicts ? "predict: " : ""}<b class="${actor.name}">${actor.name}</b> chooses <span class="muted">depth ${argument(call, "searchDepth")}, wants ${targetOf(actor.name, world)}</span>`,
				result: (call.result as Action).name,
				badge: tieBadge(call),
			}
		}
		case "scoreAction":
			return {
				label: `<b>${escapeHtml((argument(call, "action") as Action).name)}</b> <span class="muted">judged by target ${argument(call, "targetBananas")}, depth ${argument(call, "searchDepth")}</span>`,
				result: `score ${call.result}`,
			}
		case "scoreFuture":
			return { label: `<span class="muted">scoreFuture: ${argument(call, "remainingDepth")} moves left</span>`, result: String(call.result) }
		case "takeStep": {
			const after = call.result as World
			return { label: `<span class="muted">takeStep → 🍌 ${after.bananas}, agent target ${after.agentTargetBananas}${after.isDeployed ? ", deployed" : ""}</span>`, result: "" }
		}
		case "utility":
			return { label: `<span class="muted">utility (target ${argument(call, "targetBananas")})</span>`, result: String(call.result) }
		default:
			return { label: `<span class="muted">${call.functionName}</span>`, result: "" }
	}
}

// A scoreAction under chooseAction is "chosen" if its action is the one chooseAction returned.
function choiceStatus(call: CallNode, parentCall: CallNode | null) {
	if (call.functionName !== "scoreAction" || parentCall?.functionName !== "chooseAction") return ""
	return (argument(call, "action") as Action) === parentCall.result ? "chosen" : "unchosen"
}

// Open the path the actor expects: chosen options and everything that follows them.
function opensByDefault(call: CallNode, parentCall: CallNode | null, nesting: number) {
	if (call.functionName === "takeStep" || call.functionName === "utility") return false
	return nesting < 24 && choiceStatus(call, parentCall) !== "unchosen"
}

function mayHaveChildren(call: CallNode) {
	return call.children === null || call.children.length > 0
}

let selectedRow: TreeRow | null = null

function createTreeNode(call: CallNode, parentCall: CallNode | null, nesting = 0): HTMLDivElement {
	const node = document.createElement("div")
	const row = document.createElement("div") as TreeRow
	const { label, result, badge = "" } = describeCall(call, parentCall)
	const status = choiceStatus(call, parentCall)
	row.className = `row ${status}`
	row.innerHTML = `${chevronIcon}${status === "chosen" ? checkIcon : ""}<span class="label">${label}</span>${badge}<span class="result">${escapeHtml(result)}</span>`
	row.callNode = call
	row.parentCallNode = parentCall
	row.isOpen = false
	const toggle = row.querySelector(".toggle")!
	if (!mayHaveChildren(call)) toggle.classList.add("leaf")
	node.append(row)

	let childrenElement: HTMLDivElement | null = null
	row.setOpen = (isOpen) => {
		if (isOpen && !childrenElement) {
			// Calls are only recorded a few levels deep; re-run this call to record its children.
			if (call.children === null || call.children.some((child) => child.children === null && child.functionName !== "takeStep")) {
				call.children = recordCalls(3, call.rerun).children
			}
			if (!mayHaveChildren(call)) {
				toggle.classList.add("leaf")
				return
			}
			childrenElement = document.createElement("div")
			childrenElement.className = "children"
			for (const child of call.children!) childrenElement.append(createTreeNode(child, call, nesting + 1))
			node.append(childrenElement)
		}
		if (childrenElement) childrenElement.hidden = !isOpen
		toggle.classList.toggle("open", isOpen)
		row.isOpen = isOpen
	}
	row.addEventListener("click", (event) => {
		if ((event.target as Element).closest(".toggle") || row === selectedRow) row.setOpen(!row.isOpen)
		selectRow(row)
	})
	if (opensByDefault(call, parentCall, nesting) && mayHaveChildren(call)) row.setOpen(true)
	return node
}

function selectRow(row: TreeRow | undefined | null) {
	if (!row) return
	selectedRow?.classList.remove("selected")
	selectedRow = row
	row.classList.add("selected")
	state.selectedRowPath = rowPath(row)
	writeHash()
	row.scrollIntoView({ block: "nearest" })
	const call = row.callNode
	if (call.functionName === "takeStep") renderWorld(call.result as World, argument(call, "world") as World, "World after takeStep")
	else if (argument(call, "world")) renderWorld(argument(call, "world") as World, null, `World seen by ${call.functionName}`)
	renderCode(call)
}

/* ---------- decision view ---------- */
// The same recorded calls as the call tree, but only decisions: for each option, its score,
// the moves it expects (each predicted by the moving actor's own search), and the 🍌 after each.

type ExpectedMove = { decision: CallNode; actorName: string; action: Action; worldAfter: World }

const RECURSING_FUNCTIONS = new Set(["chooseAction", "scoreAction", "scoreFuture"])

// Calls are recorded a few levels deep; re-run a call to record more of it when needed.
function recordedChildren(call: CallNode) {
	if (call.children === null || call.children.some((child) => child.children === null && RECURSING_FUNCTIONS.has(child.functionName))) {
		call.children = recordCalls(3, call.rerun).children
	}
	return call.children!
}

function childCall(call: CallNode, functionName: string) {
	return recordedChildren(call).find((child) => child.functionName === functionName)
}

// Follows scoreAction → scoreFuture → (predicted chooseAction, next scoreAction) → … to the end of the search.
function expectedMoves(option: CallNode): ExpectedMove[] {
	const moves: ExpectedMove[] = []
	let current = option
	while (true) {
		const future = childCall(current, "scoreFuture")
		if (!future) break
		const decision = childCall(future, "chooseAction")
		const next = childCall(future, "scoreAction")
		if (!decision || !next) break
		const worldAfter = childCall(next, "takeStep")!.result as World
		moves.push({ decision, actorName: (argument(decision, "actor") as Actor).name, action: decision.result as Action, worldAfter })
		current = next
	}
	return moves
}

function moveChip(actorName: string, actionName: string) {
	return `<span class="chip"><b class="${actorName}">${actorName === "agent" ? "A" : "T"}</b> ${escapeHtml(actionName)}</span>`
}

function makeRow(className: string, html: string, call: CallNode, hasChildren: boolean, buildChildren: () => HTMLElement[]) {
	const node = document.createElement("div")
	const row = document.createElement("div") as TreeRow
	row.className = `row ${className}`
	row.innerHTML = `${chevronIcon}${html}`
	row.callNode = call
	row.parentCallNode = null
	row.isOpen = false
	const toggle = row.querySelector(".toggle")!
	if (!hasChildren) toggle.classList.add("leaf")
	node.append(row)
	let childrenElement: HTMLDivElement | null = null
	row.setOpen = (isOpen) => {
		if (!hasChildren) return
		if (isOpen && !childrenElement) {
			childrenElement = document.createElement("div")
			childrenElement.className = "children"
			childrenElement.append(...buildChildren())
			node.append(childrenElement)
		}
		if (childrenElement) childrenElement.hidden = !isOpen
		toggle.classList.toggle("open", isOpen)
		row.isOpen = isOpen
	}
	row.addEventListener("click", (event) => {
		if ((event.target as Element).closest(".toggle") || row === selectedRow) row.setOpen(!row.isOpen)
		selectRow(row)
	})
	return { node, row }
}

function createDecisionNode(decision: CallNode, isPrediction: boolean): HTMLDivElement {
	const actor = argument(decision, "actor") as Actor
	const world = argument(decision, "world") as World
	const head = `<span class="label">${isPrediction ? "predict: " : ""}<b class="${actor.name}">${actor.name}</b> chooses <span class="muted">depth ${argument(decision, "searchDepth")}, wants ${targetOf(actor.name, world)}</span></span>${tieBadge(decision)}<span class="result">${escapeHtml((decision.result as Action).name)}</span>`
	const { node, row } = makeRow("decision", head, decision, true, () => recordedChildren(decision).map((option) => createOptionNode(option, decision)))
	if (!isPrediction) row.setOpen(true)
	return node
}

function createOptionNode(option: CallNode, decision: CallNode): HTMLDivElement {
	const action = argument(option, "action") as Action
	const isChosen = action === decision.result
	const moves = expectedMoves(option)
	const worldAfterOption = childCall(option, "takeStep")!.result as World
	const bananas = [(argument(option, "world") as World).bananas, worldAfterOption.bananas, ...moves.map((move) => move.worldAfter.bananas)]
	const chips = moves.map((move) => moveChip(move.actorName, move.action.name)).join(" → ")
	const html = `${isChosen ? checkIcon : `<span class="check"></span>`}<span class="option-action">${escapeHtml(action.name)}</span>`
		+ `<span class="option-score">${option.result}</span>`
		+ `<span class="option-moves" title="expected moves: ${escapeHtml(moves.map((move) => `${move.actorName} ${move.action.name}`).join(" → "))}">${chips}</span>`
		+ `<span class="option-bananas" title="bananas before, after this action, and after each expected move">🍌 ${bananas.join(" → ")}</span>`
	const { node } = makeRow(isChosen ? "option chosen" : "option unchosen", html, option, moves.length > 0, () => moves.map((move) => createDecisionNode(move.decision, true)))
	return node
}

/* ---------- position of a row in the tree (for the URL) ---------- */

// Each tree node is a div holding its row and, once opened, a `.children` div of child nodes.
function rowPath(row: TreeRow) {
	const path: number[] = []
	let node = row.parentElement!
	while (node.parentElement?.classList.contains("children")) {
		path.unshift([...node.parentElement.children].indexOf(node))
		node = node.parentElement.parentElement!
	}
	return path
}

function selectRowAtPath(path: number[]) {
	let node = element("tree").firstElementChild as HTMLElement | null
	for (const index of path) {
		const row = node?.querySelector(":scope > .row") as TreeRow | null
		if (!row) return
		row.setOpen(true)
		node = (node!.querySelector(":scope > .children")?.children[index] as HTMLElement | undefined) ?? null
	}
	selectRow(node?.querySelector(":scope > .row") as TreeRow | null)
}

/* ---------- code with values ---------- */

const sourceLines: Record<string, string[]> = {}
const functionLocations: Record<string, { file: string; startLine: number; endLine: number }> = {}
for (const [file, source] of Object.entries(coreSources)) {
	const lines = source.split("\n")
	sourceLines[file] = lines
	lines.forEach((line, index) => {
		const match = line.match(/^(?:export )?function (\w+)\(/)
		if (!match) return
		let endLine = index
		while (endLine < lines.length - 1 && lines[endLine] !== "}") endLine++
		functionLocations[match[1]!] = { file, startLine: index, endLine }
	})
}

const KEYWORDS = "export|function|const|let|return|if|else|for|of|import|type|from|while|true|false|as"
const tokenPattern = new RegExp(String.raw`(\/\/.*$)|("(?:[^"\\]|\\.)*"|${"`"}(?:[^${"`"}\\]|\\.)*${"`"})|\b(${KEYWORDS})\b|\b(\d+)\b|\b([A-Z]\w*)\b|\b(\w+)(?=\()`, "g")
const TOKEN_CLASSES = ["", "comment", "string", "keyword", "number", "type", "function"]

function highlightSyntax(line: string) {
	let html = ""
	let position = 0
	for (const match of line.matchAll(tokenPattern)) {
		html += escapeHtml(line.slice(position, match.index))
		const group = match.findIndex((part, index) => index > 0 && part !== undefined)
		html += `<span class="token-${TOKEN_CLASSES[group]}">${escapeHtml(match[0])}</span>`
		position = match.index + match[0].length
	}
	return html + escapeHtml(line.slice(position))
}

function formatValue(value: unknown): string {
	if (value && typeof value === "object") {
		if ("bananas" in value && "turn" in value) {
			const world = value as World
			const summary = `{ bananas: ${world.bananas}, agentTargetBananas: ${world.agentTargetBananas}, turn: "${world.turn}"${world.isDeployed ? ", isDeployed: true" : ""} }`
			return `<span title="${escapeHtml(JSON.stringify(world, null, 1))}">${escapeHtml(summary)}</span>`
		}
		if ("name" in value) return escapeHtml((value as { name: string }).name)
	}
	return escapeHtml(typeof value === "string" ? `"${value}"` : String(value))
}

let linkedCalls: CallNode[] = []
function callLink(childCall: CallNode, html: string, extraClass = "") {
	linkedCalls.push(childCall)
	return `<span class="call ${extraClass}" data-call="${linkedCalls.length - 1}">${html}</span>`
}

// `if (…) return` returned early if the call made no further calls; otherwise the last `return` did.
function returnLineIndex(call: CallNode, location: { file: string; startLine: number; endLine: number }) {
	const lines = sourceLines[location.file]!
	for (let index = location.startLine; index <= location.endLine; index++) {
		if (/^\s*if \(.*\) return\b/.test(lines[index]!) && call.children?.length === 0) return index
	}
	for (let index = location.endLine; index >= location.startLine; index--) if (/\breturn\b/.test(lines[index]!)) return index
	return -1
}

// Values for one line: arguments on the signature line, the results of calls made on that line,
// and the return value on the line that returned.
function valuesForLine(call: CallNode, line: string, lineIndex: number, location: { file: string; startLine: number; endLine: number }) {
	if (lineIndex === location.startLine) {
		return call.parameterNames.map((name, index) => `${name} = ${formatValue(call.argumentValues[index])}`).join(", ")
	}
	const parts: string[] = []
	for (const [, name] of line.matchAll(/\b(\w+)\(/g)) {
		const childCalls = (call.children ?? []).filter((child) => child.functionName === name)
		if (childCalls.length > 1 && name === "scoreAction") {
			parts.push(childCalls.map((child) => {
				const action = argument(child, "action") as Action
				return callLink(child, `${escapeHtml(action.name)}: ${child.result}`, action === call.result ? "chosen" : "")
			}).join(", "))
		} else {
			for (const child of childCalls) parts.push(callLink(child, `${name}(…) = ${formatValue(child.result)}`))
		}
	}
	if (/\breturn\b/.test(line) && returnLineIndex(call, location) === lineIndex) parts.push(`returns ${formatValue(call.result)}`)
	return parts.join(" · ")
}

function renderCode(call: CallNode) {
	const location = functionLocations[call.functionName]
	const codeElement = element("code")
	linkedCalls = []
	if (!location) {
		codeElement.innerHTML = ""
		return
	}
	if (call.children === null) call.children = recordCalls(3, call.rerun).children
	element("code-title").textContent = `${location.file}:${location.startLine + 1}`
	const lines = sourceLines[location.file]!
	const lastExecutedLine = returnLineIndex(call, location)
	let firstLine = location.startLine
	while (firstLine > 0 && lines[firstLine - 1]!.startsWith("//")) firstLine--
	let html = ""
	for (let index = firstLine; index <= location.endLine; index++) {
		const line = lines[index]!
		const values = index >= location.startLine ? valuesForLine(call, line, index, location) : ""
		const skipped = index > lastExecutedLine && index < location.endLine
		const indent = line.match(/^\t*/)![0].length * 2
		html += `<div class="line${skipped ? " skipped" : ""}"><span class="number">${index + 1}</span><span class="source">${highlightSyntax(line) || " "}</span></div>`
		if (values) html += `<div class="values" style="margin-left: calc(4.5em + ${indent}ch)">${values}</div>`
	}
	codeElement.innerHTML = html
}

// Clicking a value steps into the call that produced it.
element("code").addEventListener("click", (event) => {
	const link = (event.target as Element).closest(".call") as HTMLElement | null
	if (!link || !selectedRow) return
	const childCall = linkedCalls[Number(link.dataset["call"])]
	selectedRow.setOpen(true)
	const childRows = selectedRow.parentElement!.querySelectorAll(":scope > .children > div > .row")
	selectRow([...childRows].find((row) => (row as TreeRow).callNode === childCall) as TreeRow | undefined)
})

/* ---------- scrubbing: middle-click a number and drag ---------- */

const PIXELS_PER_UNIT = 8

function scrubNumberInput(input: HTMLInputElement, startEvent: MouseEvent) {
	const startX = startEvent.clientX
	const startValue = Number(input.value)
	const min = input.min === "" ? -Infinity : Number(input.min)
	const max = input.max === "" ? Infinity : Number(input.max)
	document.body.classList.add("scrubbing")
	function onMove(moveEvent: MouseEvent) {
		const value = Math.max(min, Math.min(max, startValue + Math.round((moveEvent.clientX - startX) / PIXELS_PER_UNIT)))
		if (String(value) === input.value) return
		input.value = String(value)
		input.dispatchEvent(new Event("input", { bubbles: true }))
		input.dispatchEvent(new Event("change", { bubbles: true }))
	}
	function onUp() {
		document.body.classList.remove("scrubbing")
		window.removeEventListener("mousemove", onMove)
		window.removeEventListener("mouseup", onUp)
	}
	window.addEventListener("mousemove", onMove)
	window.addEventListener("mouseup", onUp)
}

document.addEventListener("mousedown", (event) => {
	if (event.button !== 1) return
	const input = (event.target as Element).closest('input[type="number"]') as HTMLInputElement | null
	if (!input) return
	event.preventDefault() // no autoscroll
	scrubNumberInput(input, event)
})

/* ---------- keyboard ---------- */

function visibleRows() {
	return [...document.querySelectorAll("#tree .row")].filter((row) => (row as HTMLElement).offsetParent !== null) as TreeRow[]
}

document.addEventListener("keydown", (event) => {
	if (event.ctrlKey || event.metaKey || event.altKey) return
	if ((event.target as Element).closest("input, select")) return
	if (event.key === "n") selectStep(state.selectedStepIndex + 1)
	else if (event.key === "p") selectStep(state.selectedStepIndex - 1)
	else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		const rows = visibleRows()
		selectRow(rows[rows.indexOf(selectedRow!) + (event.key === "ArrowDown" ? 1 : -1)])
	} else if (event.key === "ArrowRight" && selectedRow) {
		if (!selectedRow.isOpen && mayHaveChildren(selectedRow.callNode)) selectedRow.setOpen(true)
		else selectRow(visibleRows()[visibleRows().indexOf(selectedRow) + 1])
	} else if (event.key === "ArrowLeft" && selectedRow) {
		if (selectedRow.isOpen) selectedRow.setOpen(false)
		else selectRow(selectedRow.closest(".children")?.parentElement?.querySelector(":scope > .row") as TreeRow | null)
	} else return
	event.preventDefault()
})

/* ---------- light/dark theme ---------- */

const SUN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`
const MOON_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`

function renderThemeButton() {
	// Shows the theme you'd switch to.
	element("theme").innerHTML = document.documentElement.dataset["theme"] === "dark" ? SUN_ICON : MOON_ICON
}

element("theme").addEventListener("click", () => {
	const theme = document.documentElement.dataset["theme"] === "dark" ? "light" : "dark"
	document.documentElement.dataset["theme"] = theme
	localStorage.setItem("theme", theme)
	renderThemeButton()
	renderRun() // the heatmap ramp and cell text are picked per theme
	renderSweep()
})

/* ---------- start ---------- */

const initialPosition = new URLSearchParams(location.hash.slice(1))
element<HTMLInputElement>("show-all-calls").checked = initialPosition.get("allCalls") === "1"
state.selectedStepIndex = Math.max(0, Number(initialPosition.get("step") ?? 1) - 1)
const initialRowPath = (initialPosition.get("row") ?? "").split(".").filter(Boolean).map(Number)
renderThemeButton()
renderParameterInputs()
renderSweepControls()
setParameters(state.parameters)
selectRowAtPath(initialRowPath)
