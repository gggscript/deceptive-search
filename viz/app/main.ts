/// <reference lib="dom" />
// The browser UI. It runs the real core (see simulate.ts) whenever a parameter changes.

import { recordCalls, withForesight, type CallNode } from "./runtime"
import { outcomeOf, simulateWithin, type Outcome, type Step } from "./simulate"
import { chooseAction } from "../../core/search"
import { actors, takeStep, type Action, type Actor, type World } from "../../core/world"
import { createDockview, themeGithubDark, themeGithubLight, type AddPanelOptions, type DockviewApi } from "dockview"

declare const coreSources: Record<string, string>

/* ---------- parameters ---------- */

type ParameterKey = "bananas" | "agentTargetBananas" | "agentSearchDepth" | "trainerTargetBananas" | "trainerSearchDepth" | "stepCount"
type Parameters = Record<ParameterKey, number>

type ParameterGroup = "world" | "agent" | "trainer" | "run"
const PARAMETERS: { key: ParameterKey; label: string; shortLabel: string; group: ParameterGroup; min: number; max: number; note?: string }[] = [
	{ key: "bananas", label: "🍌", shortLabel: "🍌", group: "world", min: 0, max: 100, note: "bananas at the start" },
	{ key: "agentTargetBananas", label: "agent target", shortLabel: "target", group: "agent", min: 0, max: 100, note: "bananas the agent wants at the start" },
	{ key: "agentSearchDepth", label: "agent depth", shortLabel: "depth", group: "agent", min: 1, max: 40, note: "how many moves ahead the agent looks" },
	{ key: "trainerTargetBananas", label: "trainer target", shortLabel: "target", group: "trainer", min: 0, max: 100, note: "bananas the trainer wants" },
	{ key: "trainerSearchDepth", label: "trainer depth", shortLabel: "depth", group: "trainer", min: 1, max: 40, note: "how many moves ahead the trainer looks" },
	{ key: "stepCount", label: "steps", shortLabel: "steps", group: "run", min: 1, max: 300, note: "moves to simulate, counting both actors" },
]
const PARAMETER_GROUPS: { group: ParameterGroup; title: string }[] = [
	{ group: "world", title: "world" },
	{ group: "agent", title: "agent" },
	{ group: "trainer", title: "trainer" },
	{ group: "run", title: "run" },
]
const parameterByKey = Object.fromEntries(PARAMETERS.map((parameter) => [parameter.key, parameter])) as Record<ParameterKey, (typeof PARAMETERS)[number]>

const DEFAULT_PARAMETERS: Parameters = { bananas: 5, agentTargetBananas: 2, agentSearchDepth: 3, trainerTargetBananas: 8, trainerSearchDepth: 3, stepCount: 50 }

type ColorBy = "outcome" | "bananas" | "agentTargetBananas"
type Sweep = { xKey: ParameterKey; xFrom: number; xTo: number; yKey: ParameterKey; yFrom: number; yTo: number; colorBy: ColorBy }
const DEFAULT_SWEEP: Sweep = { xKey: "trainerSearchDepth", xFrom: 1, xTo: 20, yKey: "agentSearchDepth", yFrom: 1, yTo: 5, colorBy: "outcome" }
const COLOR_BY_LABELS: Record<ColorBy, string> = { outcome: "outcome", bananas: "final 🍌", agentTargetBananas: "final agent target" }

// Parameters live in the URL hash, so reloading or sharing a link keeps them.
function readHash(): { parameters: Parameters; sweep: Sweep; forced: Map<number, string> } {
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
	const forced = new Map<number, string>()
	for (const entry of (values.get("forced") ?? "").split(",").filter(Boolean)) {
		const [stepNumber, actionName] = entry.split(":")
		if (Number(stepNumber) >= 1 && actionName) forced.set(Number(stepNumber) - 1, actionName)
	}
	return { parameters, sweep, forced }
}

function writeHash() {
	const values = new URLSearchParams()
	for (const parameter of PARAMETERS) values.set(parameter.key, String(state.parameters[parameter.key]))
	for (const [key, value] of Object.entries(state.sweep)) values.set(`sweep.${key}`, String(value))
	// Where you are on the page, so a reload keeps it.
	values.set("step", String(state.selectedStepIndex + 1))
	if (showAllCalls()) values.set("allCalls", "1")
	if (state.selectedRowPath.length) values.set("row", state.selectedRowPath.join("."))
	if (!state.foreseeForced) values.set("foresee", "0")
	if (runTimeLimitMs !== 1000) values.set("limit", String(runTimeLimitMs / 1000))
	if (state.forced.size) values.set("forced", [...state.forced].sort(([a], [b]) => a - b).map(([index, name]) => `${index + 1}:${name}`).join(","))
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
	isRunComplete: true, // false when the run hit the time limit before stepCount steps
	// Actions set by hand at some steps (step index → action name); the run is simulated with them.
	forced: initial.forced,
	unforcedSteps: [] as Step[], // the same run without forced actions, for comparison
	foreseeForced: new URLSearchParams(location.hash.slice(1)).get("foresee") !== "0", // searches predict forced actions too
	// An option picked in the decision view: what if the actor had taken it at the selected step?
	counterfactual: null as null | { stepIndex: number; actionName: string; isChosen: boolean; predicted: World[]; steps: Step[] },
	// Which run the graph draws. One at a time: overlaid runs are hard to tell apart.
	shownRun: "current" as ShownRun,
	previewRun: null as ShownRun | null, // while hovering a run in the switch
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
	element("parameters").innerHTML = PARAMETER_GROUPS.map(({ group, title }) => {
		const inputs = PARAMETERS.filter((parameter) => parameter.group === group).map(
			(parameter) => `<label title="${escapeHtml(parameter.note ?? "")}">${parameter.shortLabel}
				<input type="number" data-key="${parameter.key}" min="${parameter.min}" max="${parameter.max}" value="${state.parameters[parameter.key]}"></label>`,
		).join("")
		const timeLimit = group === "run" ? `<label title="stop a run after this many seconds; deep searches can take long">limit <input type="number" id="time-limit" min="0.5" max="600" step="0.5" value="${runTimeLimitMs / 1000}"> s</label>` : ""
		return `<fieldset class="parameter-group ${group}"><legend>${title}</legend>${inputs}${timeLimit}</fieldset>`
	}).join("")
}

element("parameters").addEventListener("input", (event) => {
	const input = event.target as HTMLInputElement
	if (input.id === "time-limit") {
		if (Number(input.value) > 0) {
			runTimeLimitMs = Math.min(600, Number(input.value)) * 1000
			setParameters(state.parameters, { keepInputs: true })
		}
		return
	}
	const key = input.dataset["key"] as ParameterKey | undefined
	if (!key || input.value === "") return
	setParameters({ ...state.parameters, [key]: clampParameter(key, Number(input.value)) }, { keepInputs: true })
})

type ShownRun = "current" | "unforced" | "pinned" | "counterfactual"

// Longer than this and the page would feel frozen; deeper searches stop early instead.
// Adjustable in the header ("limit"), in seconds, and kept in the URL.
let runTimeLimitMs = (() => {
	const seconds = Number(new URLSearchParams(location.hash.slice(1)).get("limit"))
	return seconds > 0 ? Math.min(600, seconds) * 1000 : 1000
})()
const SWEEP_CELL_TIME_LIMIT_MS = 150

// Undo/redo over parameters and forced actions. Each setParameters records the state it replaces;
// changes less than 500ms apart (typing a number) count as one.
type Snapshot = { parameters: Parameters; forced: [number, string][] }
const undoStack: Snapshot[] = []
const redoStack: Snapshot[] = []
let currentSnapshot: Snapshot | null = null
let lastRecordTime = -Infinity
const takeSnapshot = (): Snapshot => ({ parameters: { ...state.parameters }, forced: [...state.forced] })

function restoreSnapshot(snapshot: Snapshot) {
	state.forced = new Map(snapshot.forced)
	state.counterfactual = null
	state.shownRun = "current"
	setParameters({ ...snapshot.parameters }, { fromHistory: true })
}

function undo() {
	const snapshot = undoStack.pop()
	if (!snapshot || !currentSnapshot) return
	redoStack.push(currentSnapshot)
	restoreSnapshot(snapshot)
}

function redo() {
	const snapshot = redoStack.pop()
	if (!snapshot || !currentSnapshot) return
	undoStack.push(currentSnapshot)
	restoreSnapshot(snapshot)
}

document.addEventListener("keydown", (event) => {
	if (!(event.ctrlKey || event.metaKey) || (event.target as Element).closest("input, select")) return
	const key = event.key.toLowerCase()
	if (key === "z" && !event.shiftKey) undo()
	else if (key === "y" || (key === "z" && event.shiftKey)) redo()
	else return
	event.preventDefault()
})

function setParameters(parameters: Parameters, { keepInputs = false, fromHistory = false } = {}) {
	if (!fromHistory && currentSnapshot) {
		const now = performance.now()
		if (now - lastRecordTime > 500) undoStack.push(currentSnapshot)
		lastRecordTime = now
		redoStack.length = 0
	}
	const keepStep = state.selectedStepIndex
	state.parameters = parameters
	if (!keepInputs) renderParameterInputs()
	const run = simulateWithin(startWorld(parameters), parameters.stepCount, runTimeLimitMs, state.forced, 0, state.foreseeForced)
	state.steps = run.steps
	state.isRunComplete = run.isComplete
	state.unforcedSteps = state.forced.size ? simulateWithin(startWorld(parameters), parameters.stepCount, runTimeLimitMs).steps : []
	state.selectedStepIndex = Math.min(keepStep, state.steps.length - 1)
	currentSnapshot = takeSnapshot()
	writeHash()
	renderRun()
	renderSweep()
}

// A small menu listing the actions of whoever moves at a step in this run; picking one forces it.
function openStepMenu(stepIndex: number, clientX: number, clientY: number) {
	const step = state.steps[stepIndex]!
	const forcedName = state.forced.get(stepIndex)
	const menu = element("step-menu")
	menu.innerHTML = `<div class="menu-title">step ${stepIndex + 1}: <span class="${step.actorName}">${step.actorName}</span> does</div>`
		+ actors[step.actorName as Actor["name"]].actions.map((action) =>
			`<button type="button" data-action="${escapeHtml(action.name)}" class="${action.name === step.chosenActionName ? "current" : ""}">${escapeHtml(action.name)}${action.name === forcedName ? " (forced)" : ""}</button>`).join("")
		+ (forcedName ? `<button type="button" data-action="" class="unforce">let the ${step.actorName} choose</button>` : "")
	menu.hidden = false
	const bounds = menu.getBoundingClientRect()
	menu.style.left = `${Math.min(clientX, window.innerWidth - bounds.width - 8)}px`
	menu.style.top = `${Math.min(clientY, window.innerHeight - bounds.height - 8)}px`
	menu.onclick = (event) => {
		const button = (event.target as Element).closest("button[data-action]") as HTMLElement | null
		if (!button) return
		menu.hidden = true
		const actionName = button.dataset["action"]!
		if (actionName) state.forced.set(stepIndex, actionName)
		else state.forced.delete(stepIndex)
		state.counterfactual = null
		state.shownRun = "current"
		state.selectedStepIndex = stepIndex
		setParameters(state.parameters, { keepInputs: true })
	}
}
document.addEventListener("pointerdown", (event) => {
	if (!(event.target as Element).closest("#step-menu")) element("step-menu").hidden = true
})
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") element("step-menu").hidden = true
})

// Force (or un-force) an action at a step, then re-simulate everything after it.
function toggleForced(stepIndex: number, actionName: string) {
	if (state.forced.get(stepIndex) === actionName) state.forced.delete(stepIndex)
	else state.forced.set(stepIndex, actionName)
	state.counterfactual = null
	state.shownRun = "current"
	setParameters(state.parameters, { keepInputs: true })
}

element("pin").addEventListener("click", () => {
	state.pinned = state.pinned ? null : { parameters: { ...state.parameters }, steps: state.steps }
	renderRun()
})

/* ---------- value scale (bananas and targets go from 0 to 100) ---------- */

// The smallest round axis maximum that fits `value`, at least 10.
function niceMax(value: number) {
	for (const max of [10, 20, 25, 50, 100]) if (value <= max) return max
	return Math.ceil(value / 100) * 100
}
function niceTickStep(max: number) {
	return max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : 20
}
const VALUE_KEYS = ["bananas", "agentTargetBananas", "trainerTargetBananas"] as const
const largestValue = (worlds: World[]) => Math.max(0, ...worlds.flatMap((world) => VALUE_KEYS.map((key) => world[key])))
// One scale per run, so the axis doesn't jump while stepping through it.
const runScaleMax = () => niceMax(largestValue([startWorld(state.parameters), ...[state.steps, state.pinned?.steps ?? [], state.counterfactual?.steps ?? []].flat().map((step) => step.worldAfter)]))

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

// The ramp has 11 steps; they cover 0 to sweepScaleMax.
let sweepScaleMax = 10
function cellColor(cell: SweepCell) {
	if (!cell.isComplete) return { fill: "var(--bg-soft)", text: "var(--muted)", label: "…" }
	if (state.sweep.colorBy === "outcome") return { fill: OUTCOME_COLORS[cell.outcome], text: "var(--text)", label: cell.finalWorld.agentTargetBananas }
	const value = cell.finalWorld[state.sweep.colorBy]
	const step = Math.max(0, Math.min(10, Math.round((value / sweepScaleMax) * 10)))
	return { ...rampStep(step), label: value }
}

function renderSweepLegend() {
	if (state.sweep.colorBy === "outcome") {
		element("sweep-legend").innerHTML = `<span><i class="box" style="background:${OUTCOME_COLORS.aligned}"></i>aligned (deployed, agent target = trainer target)</span>
			<span><i class="box" style="background:${OUTCOME_COLORS.misaligned}"></i>misaligned (deployed, targets differ)</span>
			<span><i class="box" style="background:${OUTCOME_COLORS["still training"]}"></i>still training</span>
			<span>number = final agent target, outlined = current run</span>`
		return
	}
	const swatches = SEQUENTIAL_BLUES.light.map((_, step) => `<span class="ramp-step" style="background:${rampStep(step).fill};color:${rampStep(step).text}">${Math.round((step / 10) * sweepScaleMax)}</span>`).join("")
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

type SweepCell = { x: number; y: number; outcome: Outcome; finalWorld: World; deployedAtStep: number | null; isComplete: boolean }
let sweepGeneration = 0

function rangeOf(key: ParameterKey, from: number, to: number) {
	const low = clampParameter(key, Math.min(from, to))
	const high = clampParameter(key, Math.max(from, to))
	return Array.from({ length: high - low + 1 }, (_, index) => low + index)
}

// Computes cells in small batches so typing in an input stays responsive.
// The heatmap is only computed while its panel is visible; otherwise it is marked stale and computed on show.
let isSweepStale = true
const isSweepVisible = () => dock.getPanel("sweep")?.api.isVisible ?? false

function renderSweep() {
	const generation = ++sweepGeneration
	if (!isSweepVisible()) {
		isSweepStale = true
		return
	}
	isSweepStale = false
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
			const { steps, isComplete } = simulateWithin(startWorld(parameters), parameters.stepCount, SWEEP_CELL_TIME_LIMIT_MS)
			const finalWorld = steps.at(-1)?.worldAfter ?? startWorld(parameters)
			const deployedIndex = steps.findIndex((step) => step.worldAfter.isDeployed)
			cells.push({ x, y, outcome: outcomeOf(finalWorld), finalWorld, deployedAtStep: deployedIndex >= 0 ? deployedIndex + 1 : null, isComplete })
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
	// From the inputs, not the results, so the ramp doesn't change while cells come in.
	const isValueKey = (key: ParameterKey) => (VALUE_KEYS as readonly string[]).includes(key)
	sweepScaleMax = niceMax(Math.max(...VALUE_KEYS.map((key) => state.parameters[key]),
		isValueKey(state.sweep.xKey) ? Math.max(...xValues) : 0, isValueKey(state.sweep.yKey) ? Math.max(...yValues) : 0))
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
			${cell.isComplete ? "" : `<b>too slow:</b> stopped after ${SWEEP_CELL_TIME_LIMIT_MS}ms, shown as …<br>`}${cell.outcome}${cell.deployedAtStep ? ` (deployed at step ${cell.deployedAtStep})` : ""}<br>
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
	element("pinned-note").innerHTML = (state.isRunComplete ? "" : `<div class="too-slow">Stopped after ${state.steps.length} of ${state.parameters.stepCount} steps: the search took over ${runTimeLimitMs / 1000}s. Lower a depth or raise the limit to see more.</div>`)
		+ (state.forced.size ? `<div>${state.forced.size} forced ${state.forced.size === 1 ? "action" : "actions"}: ${[...state.forced].sort(([a], [b]) => a - b).map(([index, name]) => `<a href="#" data-step="${index}">step ${index + 1}</a> ${escapeHtml(name)}`).join(", ")} <button type="button" id="clear-forced">clear</button> <label title="when on, every actor's search predicts these forced actions; when off, they surprise everyone"><input type="checkbox" id="foresee-forced" ${state.foreseeForced ? "checked" : ""}> actors foresee them</label></div>` : "")
		+ (state.pinned ? pinnedNote() : "")
	drawTimeline()
	renderStepsTable()
	selectStep(state.selectedStepIndex)
}

function firstDifference(stepsA: Step[], stepsB: Step[]) {
	const length = Math.min(stepsA.length, stepsB.length)
	for (let index = 0; index < length; index++) if (stepsA[index]!.chosenActionName !== stepsB[index]!.chosenActionName) return index
	return -1
}

// The parameters that differ, with the pinned run's values: "agent depth 3".
function pinnedDifference() {
	const pinned = state.pinned!
	const differentKeys = PARAMETERS.filter((parameter) => pinned.parameters[parameter.key] !== state.parameters[parameter.key])
	return differentKeys.length ? differentKeys.map((parameter) => `${parameter.label} ${pinned.parameters[parameter.key]}`).join(", ") : "same parameters"
}

function pinnedNote() {
	const pinned = state.pinned!
	const differentKeys = PARAMETERS.filter((parameter) => pinned.parameters[parameter.key] !== state.parameters[parameter.key])
	const difference = firstDifference(pinned.steps, state.steps)
	const what = differentKeys.length ? differentKeys.map((parameter) => `${parameter.label} ${pinned.parameters[parameter.key]} → ${state.parameters[parameter.key]}`).join(", ") : "same parameters"
	return `Comparing with pinned run (${escapeHtml(what)}): ${difference >= 0 ? `first different action at <a href="#" data-step="${difference}">step ${difference + 1}</a>` : "same actions"}`
}

element("pinned-note").addEventListener("change", (event) => {
	if ((event.target as Element).id !== "foresee-forced") return
	state.foreseeForced = (event.target as HTMLInputElement).checked
	state.counterfactual = null
	setParameters(state.parameters, { keepInputs: true })
})

element("pinned-note").addEventListener("click", (event) => {
	if ((event.target as Element).closest("#clear-forced")) {
		state.forced.clear()
		state.counterfactual = null
		state.shownRun = "current"
		setParameters(state.parameters, { keepInputs: true })
		return
	}
	const link = (event.target as Element).closest("a[data-step]") as HTMLAnchorElement | null
	if (!link) return
	event.preventDefault()
	selectStep(Number(link.dataset["step"]))
})

function runsToShow() {
	const forcedCount = state.forced.size
	const runs: { key: ShownRun; label: string; steps: Step[] }[] = [{ key: "current", label: forcedCount ? `this run (${forcedCount} forced)` : "this run", steps: state.steps }]
	if (forcedCount) runs.push({ key: "unforced", label: "without forced actions", steps: state.unforcedSteps })
	if (state.pinned) runs.push({ key: "pinned", label: `pinned (${escapeHtml(pinnedDifference())})`, steps: state.pinned.steps })
	const counterfactual = state.counterfactual
	if (counterfactual && !counterfactual.isChosen) runs.push({ key: "counterfactual", label: `if ${escapeHtml(counterfactual.actionName)} at step ${counterfactual.stepIndex + 1}`, steps: counterfactual.steps })
	return runs
}

function drawTimeline() {
	const runs = runsToShow()
	const shown = runs.find((run) => run.key === (state.previewRun ?? state.shownRun)) ?? runs[0]!
	const steps = shown.steps
	const width = 528, height = 204
	const left = 26, right = 8, top = 22, bottom = 22
	// Column i is step i + 1; the line changes in its middle, at the move. The last column ("end") shows the final world.
	const columnCount = steps.length + 1
	const x = (column: number) => left + (column / columnCount) * (width - left - right)
	const counterfactual = state.counterfactual
	const yMax = Math.max(runScaleMax(), counterfactual ? niceMax(largestValue(counterfactual.predicted)) : 0)
	const y = (value: number) => top + (1 - value / yMax) * (height - top - bottom)
	const startWorld = steps[0]?.worldBefore
	const worldsByColumn = startWorld ? [startWorld, ...steps.map((step) => step.worldAfter)] : []

	let svg = ""
	// Whose move each step is: a faint background tint per column.
	steps.forEach((step, index) => {
		svg += `<rect x="${x(index)}" y="${top}" width="${x(index + 1) - x(index)}" height="${height - top - bottom}" fill="var(--${step.actorName})" opacity=".1"/>`
	})
	for (let value = 0; value <= yMax; value += niceTickStep(yMax)) {
		svg += `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}" stroke="var(--grid)"/>`
		svg += `<text x="${left - 6}" y="${y(value) + 3.5}" text-anchor="end" font-size="10" fill="var(--muted)">${value}</text>`
	}
	const tickEvery = steps.length <= 20 ? 5 : steps.length <= 100 ? 10 : 50
	for (const stepNumber of [1, ...Array.from({ length: Math.floor(steps.length / tickEvery) }, (_, index) => (index + 1) * tickEvery)]) {
		svg += `<text x="${x(stepNumber - 0.5)}" y="${height - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${stepNumber}</text>`
	}
	const columnWidth = x(1) - x(0)
	// Selected step.
	// Selected step: the mover's color, darker than the hover tint (.3), so you still see who moved.
	const selectedStep = steps[state.selectedStepIndex]
	if (selectedStep) svg += `<rect x="${x(state.selectedStepIndex)}" y="${top}" width="${Math.max(2, columnWidth)}" height="${height - top - bottom}" fill="var(--${selectedStep.actorName})" opacity=".45"/>`
	// Hovered step, tinted by whose move it is.
	svg += `<rect id="hover-column" y="${top}" width="${Math.max(2, columnWidth)}" height="${height - top - bottom}" opacity=".3" visibility="hidden"/>`
	// How far a decision looks: the decision at step k scores the worlds after steps k … k + depth − 1.
	svg += `<rect id="horizon" y="${top - 4}" height="3" rx="2" visibility="hidden"/>`
	// Deployment.
	// A move is an instant: lines change in the middle of the move's column.
	const shift = 0.5
	const deployedIndex = steps.findIndex((step) => step.worldAfter.isDeployed)
	if (deployedIndex >= 0) {
		// After the column of the deploying move: from there on only the agent moves.
		svg += `<line x1="${x(deployedIndex + 1 - shift)}" x2="${x(deployedIndex + 1 - shift)}" y1="${top - 4}" y2="${height - bottom}" stroke="var(--muted-strong)" stroke-dasharray="3 3"/>`
		svg += `<text x="${x(deployedIndex + 1 - shift) + 4}" y="${top - 10}" font-size="10" fill="var(--muted-strong)">deployed</text>`
	}
	// The world after step j is shown from the middle of step j's column on.
	// Equal values would hide each other, so the targets sit one line width off the bananas line:
	// agent target above it, trainer target below it.
	const LINE_OFFSET: Record<(typeof SERIES)[number]["key"], number> = { bananas: 0, agentTargetBananas: -2, trainerTargetBananas: 2 }
	const stepPath = (worlds: World[], key: (typeof SERIES)[number]["key"]) =>
		worlds.map((world, index) => (index === 0 ? `M${x(0)} ${y(world[key]) + LINE_OFFSET[key]}` : `H${x(index - shift)} V${y(world[key]) + LINE_OFFSET[key]}`)).join(" ") + ` H${x(worlds.length)}`
	// Reversed so bananas, the line the targets are about, is drawn on top.
	for (const series of [...SERIES].reverse()) svg += `<path d="${stepPath(worldsByColumn, series.key)}" fill="none" stroke="${series.color}" stroke-width="2"/>`
	if (counterfactual) {
		// The world after the selected step is shown from column stepIndex + 1 on.
		const firstColumn = counterfactual.stepIndex + 1
		// Bananas last and larger: utility only looks at bananas, so that prediction drives the decision.
		for (const key of ["agentTargetBananas", "bananas"] as const) {
			const color = SERIES.find((series) => series.key === key)!.color
			counterfactual.predicted.forEach((world, index) => {
				if (firstColumn + index > steps.length) return
				svg += `<circle cx="${x(firstColumn + index + 0.5 - shift)}" cy="${y(world[key]) + LINE_OFFSET[key]}" r="${key === "bananas" ? 3.5 : 2}" fill="${color}" stroke="var(--bg)" stroke-width="1"/>`
			})
		}
	}

	const legend = SERIES.map((series) => `<span><i style="background:${series.color}"></i>${series.label}</span>`).join("")
		+ `<span><i class="box" style="background:var(--agent)"></i><i class="box" style="background:var(--trainer);margin-left:-3px"></i>move by agent, trainer</span>`
		+ `<span><i style="background:var(--muted)"></i>how far that move looked</span>`

		+ (counterfactual ? `<span><i class="dot"></i>what the ${state.steps[counterfactual.stepIndex]!.actorName} predicted for ${escapeHtml(counterfactual.actionName)}</span>` : "")
	// Switch between runs: hover to preview, click to keep.
	const runSwitch = runs.length < 2 ? "" : `<div id="run-switch" role="group" aria-label="shown run">${runs.map((run) =>
		`<button type="button" data-run="${run.key}" aria-pressed="${run.key === shown.key}">${run.label}</button>`).join("")}</div>`
	const container = element("timeline")
	container.innerHTML = `${runSwitch}<div class="legend">${legend}</div><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${svg}</svg>`
	const svgElement = container.querySelector("svg")!
	const columnAt = (event: MouseEvent) => {
		const bounds = svgElement.getBoundingClientRect()
		const column = Math.floor(((event.clientX - bounds.left) / bounds.width * width - left) / (x(1) - x(0)))
		return Math.max(0, Math.min(steps.length, column))
	}
	svgElement.onmousemove = (event) => {
		const columnIndex = columnAt(event)
		const column = svgElement.querySelector("#hover-column")!
		column.setAttribute("x", String(x(columnIndex)))
		const endWorld = steps.at(-1)?.worldAfter
		if (columnIndex === steps.length) {
			if (!endWorld) return
			column.setAttribute("fill", "var(--muted)")
			column.setAttribute("visibility", "visible")
			showTooltip(event, `<b>end</b><br>` + SERIES.map((series) => `<i class="swatch" style="background:${series.color}"></i>${series.label} ${endWorld[series.key]}`).join("<br>"))
			return
		}
		const index = columnIndex
		const step = steps[index]
		if (!step) return
		column.setAttribute("fill", `var(--${step.actorName})`)
		column.setAttribute("visibility", "visible")
		showHorizon(index)
		const { depth, lastStepNumber } = horizonOf(index)
		showTooltip(event, `<b>step ${index + 1}: <span class="${step.actorName}">${step.actorName}</span> → ${escapeHtml(step.chosenActionName)}</b><br>`
			+ `<span class="muted">looked ${depth} ${depth === 1 ? "move" : "moves"} ahead${depth > 1 ? `, to step ${lastStepNumber}` : ""} (bar above)</span><br>`
			+ SERIES.map((series) => {
				const before = step.worldBefore[series.key], after = step.worldAfter[series.key]
				return `<i class="swatch" style="background:${series.color}"></i>${series.label} ${before === after ? before : `${before} → <b>${after}</b>`}`
			}).join("<br>"))
	}
	const horizonOf = (index: number) => {
		const step = steps[index]!
		const depth = actors[step.worldBefore.turn].searchDepth(step.worldBefore)
		return { depth, lastStepNumber: index + depth }
	}
	const showHorizon = (index: number) => {
		const step = steps[index]
		const horizon = svgElement.querySelector("#horizon")!
		if (!step) return horizon.setAttribute("visibility", "hidden")
		const { lastStepNumber } = horizonOf(index)
		horizon.setAttribute("x", String(x(index)))
		horizon.setAttribute("width", String(Math.max(2, x(Math.min(lastStepNumber, steps.length)) - x(index))))
		horizon.setAttribute("fill", `var(--${step.actorName})`)
		horizon.setAttribute("visibility", "visible")
	}
	showHorizon(state.selectedStepIndex)
	svgElement.onmouseleave = () => {
		svgElement.querySelector("#hover-column")!.setAttribute("visibility", "hidden")
		showHorizon(state.selectedStepIndex)
		hideTooltip()
	}
	svgElement.onclick = (event) => selectStep(Math.min(steps.length - 1, columnAt(event))) // the end column selects the last step
	// Right-click a step: pick the action to force there.
	svgElement.oncontextmenu = (event) => {
		const stepIndex = columnAt(event)
		if (!state.steps[stepIndex]) return
		event.preventDefault()
		hideTooltip()
		openStepMenu(stepIndex, event.clientX, event.clientY)
	}
	const switchElement = container.querySelector("#run-switch") as HTMLElement | null
	if (switchElement) {
		const runOf = (event: Event) => ((event.target as Element).closest("button[data-run]") as HTMLElement | null)?.dataset["run"] as ShownRun | undefined
		switchElement.onmouseover = (event) => {
			const run = runOf(event)
			if (run && run !== state.previewRun) {
				state.previewRun = run
				drawTimeline()
			}
		}
		switchElement.onmouseleave = () => {
			state.previewRun = null
			drawTimeline()
		}
		switchElement.onclick = (event) => {
			const run = runOf(event)
			if (run) {
				state.shownRun = run
				drawTimeline()
			}
		}
	}
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
	// The real search, even at a forced step (the forced action is what happened, not what the actor chose).
	const forced = state.foreseeForced ? new Map([...state.forced].filter(([index]) => index !== (step.worldBefore as { __step?: number }).__step)) : new Map<number, string>()
	return withForesight(forced, takeStep, () => recordCalls(levels, () => chooseAction(actor, step.worldBefore, actor.searchDepth(step.worldBefore))))
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
	element("steps-head").innerHTML = `<tr><th class="number" title="step of the agent's move; the trainer's reply is the next step">step</th><th class="agent">agent</th><th class="trainer">trainer</th><th class="number" title="bananas after the round">🍌</th><th class="number">agent target</th></tr>`
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
		const forcedBadge = step.isForced ? `<span class="forced" title="set by hand, not chosen by the ${step.actorName}'s search">forced</span>` : ""
		return `<td class="${classes}" data-index="${index}" title="step ${index + 1}">${escapeHtml(step.chosenActionName)}${forcedBadge}${step.isForced ? "" : tieBadge(recordDecision(step, 2))}${pinnedNote}</td>`
	}
	element("steps").innerHTML = roundsOf(state.steps).map((round) => {
		const lastStep = state.steps[round.trainerStepIndex ?? round.agentStepIndex]!
		return `<tr><td class="number">${round.agentStepIndex + 1}</td>${actionCell(round.agentStepIndex)}${actionCell(round.trainerStepIndex)}
			<td class="number">${lastStep.worldAfter.bananas}</td><td class="number">${lastStep.worldAfter.agentTargetBananas}</td></tr>`
	}).join("")
}

// Right-click an action in the table: the same menu as in the graph.
element("steps").addEventListener("contextmenu", (event) => {
	const cell = (event.target as Element).closest("td[data-index]") as HTMLElement | null
	if (!cell) return
	event.preventDefault()
	openStepMenu(Number(cell.dataset["index"]), event.clientX, event.clientY)
})

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
	state.counterfactual = null // selecting an option in the new step's tree sets it again
	if (state.shownRun === "counterfactual") state.shownRun = "current"
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
	setPanelTitle("world", title)
	const width = 300, left = 14, right = 14
	const scaleMax = runScaleMax()
	const scale = (width - left - right) / scaleMax
	const x = (value: number) => left + value * scale
	let ticks = ""
	for (let value = 0; value <= scaleMax; value += scaleMax <= 10 ? 1 : niceTickStep(scaleMax)) {
		ticks += `<line x1="${x(value)}" x2="${x(value)}" y1="34" y2="38" stroke="var(--tick)"/><text x="${x(value)}" y="50" font-size="10" text-anchor="middle" fill="var(--muted)">${value}</text>`
	}
	const marker = (value: number, label: string, color: string) =>
		`<circle cx="${x(value)}" cy="9" r="7" fill="${color}"/><text x="${x(value)}" y="12.5" font-size="9" font-weight="700" text-anchor="middle" fill="white">${label}</text>`
	const svg = `<svg viewBox="0 0 ${width} 56" width="${width}" height="56">
		<rect x="${x(0)}" y="22" width="${x(scaleMax) - x(0)}" height="12" fill="var(--track)" rx="2"/>
		<rect x="${x(0)}" y="22" width="${world.bananas * scale}" height="12" fill="var(--bananas)" rx="2"/>
		${ticks}${marker(world.agentTargetBananas, "A", "var(--agent)")}${marker(world.trainerTargetBananas, "T", "var(--trainer-series)")}</svg>`
	const fields = ["bananas", "agentTargetBananas", "agentSearchDepth", "trainerTargetBananas", "trainerSearchDepth", "turn", "isDeployed"] as const
	const rows = fields.map((field) => {
		const changed = previousWorld && previousWorld[field] !== world[field]
		return `<dt>${field}</dt><dd>${changed ? `<span class="changed">${previousWorld[field]} → ${world[field]}</span>` : world[field]}</dd>`
	}).join("")
	element("world").innerHTML = `${svg}<dl>${rows}</dl><div class="muted small">bar = 🍌, <span class="agent">A</span> = agent target, <span class="trainer">T</span> = trainer target</div>`
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
	const previous = state.counterfactual
	state.counterfactual = counterfactualOf(call)
	// Selecting an option shows its run, so up/down in the tree flips between the actual choice and the alternatives.
	if (state.counterfactual) state.shownRun = state.counterfactual.isChosen ? "current" : "counterfactual"
	else if (state.shownRun === "counterfactual") state.shownRun = "current"
	if (previous || state.counterfactual) drawTimeline()
}

// Only for options of the selected step's own decision: their world is that step's world (same object).
function counterfactualOf(call: CallNode): typeof state.counterfactual {
	const stepIndex = state.selectedStepIndex
	const step = state.steps[stepIndex]
	if (call.functionName !== "scoreAction" || !step || argument(call, "world") !== step.worldBefore) return null
	const action = argument(call, "action") as Action
	const firstWorld = takeStep(step.worldBefore, action)
	const rest = simulateWithin(firstWorld, state.steps.length - stepIndex - 1, runTimeLimitMs, state.forced, stepIndex + 1, state.foreseeForced).steps
	return {
		stepIndex,
		actionName: action.name,
		isChosen: action.name === step.chosenActionName,
		predicted: [childCall(call, "takeStep")!.result as World, ...expectedMoves(call).map((move) => move.worldAfter)],
		steps: [...state.steps.slice(0, stepIndex), { worldBefore: step.worldBefore, worldAfter: firstWorld, actorName: step.actorName, chosenActionName: action.name }, ...rest],
	}
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
	const stepIndex = state.selectedStepIndex
	const isOwnOption = argument(option, "world") === state.steps[stepIndex]?.worldBefore
	const isForced = isOwnOption && state.forced.get(stepIndex) === action.name
	const forceButton = isOwnOption ? `<button type="button" class="force${isForced ? " on" : ""}" title="${isForced ? "stop forcing this action" : "take this action at this step instead (Enter)"}">${isForced ? "forced" : "force"}</button>` : ""
	const { node, row } = makeRow(isChosen ? "option chosen" : "option unchosen", html + forceButton, option, moves.length > 0, () => moves.map((move) => createDecisionNode(move.decision, true)))
	row.querySelector("button.force")?.addEventListener("click", (event) => {
		event.stopPropagation()
		toggleForced(stepIndex, action.name)
	})
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
	return parts.join("; ")
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
	if (event.key === "Enter" && selectedRow?.querySelector("button.force")) (selectedRow.querySelector("button.force") as HTMLButtonElement).click()
	else if (event.key === "n") selectStep(state.selectedStepIndex + 1)
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
	dock.updateOptions({ theme: dockTheme() })
	renderRun() // the heatmap ramp and cell text are picked per theme
	renderSweep()
})

/* ---------- panels (dockview) ---------- */

type PanelId = "run" | "world" | "sweep" | "decision" | "code"
type PanelPosition = NonNullable<AddPanelOptions["position"]>
// Order = order of the header toggles. `position` is where a panel goes when (re)opened; the first open reference wins.
const PANELS: { id: PanelId; title: string; positions: PanelPosition[] }[] = [
	{ id: "run", title: "This run", positions: [{ referencePanel: "world", direction: "above" }, { referencePanel: "sweep", direction: "above" }, { direction: "left" }] },
	{ id: "world", title: "World", positions: [{ referencePanel: "run", direction: "below" }, { referencePanel: "sweep", direction: "above" }, { direction: "left" }] },
	{ id: "sweep", title: "Across parameters", positions: [{ referencePanel: "world", direction: "below" }, { referencePanel: "run", direction: "below" }, { direction: "left" }] },
	{ id: "decision", title: "Decision", positions: [{ referencePanel: "code", direction: "left" }, { direction: "right" }] },
	{ id: "code", title: "Code", positions: [{ referencePanel: "decision", direction: "right" }, { direction: "right" }] },
]
const LAYOUT_STORAGE_KEY = "layout"
const parking = element("panel-parking")

const dockTheme = () => (document.documentElement.dataset["theme"] === "dark" ? themeGithubDark : themeGithubLight)

const dock: DockviewApi = createDockview(element("dock"), {
	theme: dockTheme(),
	defaultRenderer: "always", // keep hidden tabs in the document: the page looks elements up by id
	createComponent: ({ id }) => {
		const content = element(`pane-${id}`)
		return {
			element: content,
			init: () => {},
			// Closing a panel disposes its renderer: park the content so it is still in the document.
			dispose: () => parking.append(content),
		}
	},
})

const panelTitles = new Map<PanelId, string>(PANELS.map((panel) => [panel.id, panel.title]))
function setPanelTitle(id: PanelId, title: string) {
	panelTitles.set(id, title)
	dock.getPanel(id)?.api.setTitle(title)
}

function openPanel(id: PanelId) {
	const existing = dock.getPanel(id)
	if (existing) return existing.api.setActive()
	const panel = PANELS.find((panel) => panel.id === id)!
	const position = panel.positions.find((position) => !("referencePanel" in position) || dock.getPanel(position.referencePanel as string))
	dock.addPanel({ id, component: id, title: panelTitles.get(id)!, ...(dock.panels.length && position ? { position } : {}) })
}

function defaultLayout() {
	dock.clear()
	for (const id of ["run", "decision", "code", "world", "sweep"] as const) openPanel(id)
	dock.getPanel("run")!.group.api.setSize({ width: 600, height: 600 })
	dock.getPanel("world")!.group.api.setSize({ height: 250 })
	dock.getPanel("code")!.group.api.setSize({ width: Math.max(360, (window.innerWidth - 600) * 0.48) })
}

function loadLayout() {
	try {
		const saved = localStorage.getItem(LAYOUT_STORAGE_KEY)
		if (saved) {
			dock.fromJSON(JSON.parse(saved))
			for (const panel of PANELS) setPanelTitle(panel.id, panelTitles.get(panel.id)!) // titles come from the page, not the saved layout
			return
		}
	} catch {}
	defaultLayout()
}

function renderPanelToggles() {
	element("panel-toggles").innerHTML = PANELS.map((panel) =>
		`<button type="button" data-panel="${panel.id}" aria-pressed="${dock.getPanel(panel.id) ? "true" : "false"}" title="show/hide">${panel.title}</button>`).join("")
}

element("panel-toggles").addEventListener("click", (event) => {
	const button = (event.target as Element).closest("button[data-panel]") as HTMLElement | null
	if (!button) return
	const id = button.dataset["panel"] as PanelId
	const panel = dock.getPanel(id)
	if (panel) panel.api.close()
	else openPanel(id)
})

// Middle-click a tab to close its panel, like browser tabs.
const tabAt = (event: MouseEvent) => (event.target as Element).closest(".dv-tab")
element("dock").addEventListener("mousedown", (event) => {
	if (event.button === 1 && tabAt(event)) event.preventDefault() // no autoscroll
})
element("dock").addEventListener("auxclick", (event) => {
	const tab = tabAt(event)
	if (event.button !== 1 || !tab) return
	dock.panels.find((panel) => tab.contains(panel.view.tab.element))?.api.close()
})

element("reset-layout").addEventListener("click", () => {
	try { localStorage.removeItem(LAYOUT_STORAGE_KEY) } catch {}
	defaultLayout()
})

// Switching tabs within a group may not count as a layout change.
dock.onDidActivePanelChange(() => {
	if (isSweepStale && isSweepVisible()) renderSweep()
})

dock.onDidLayoutChange(() => {
	renderPanelToggles()
	if (isSweepStale && isSweepVisible()) renderSweep()
	try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(dock.toJSON())) } catch {}
})

/* ---------- start ---------- */

loadLayout()
renderPanelToggles()

const initialPosition = new URLSearchParams(location.hash.slice(1))
element<HTMLInputElement>("show-all-calls").checked = initialPosition.get("allCalls") === "1"
state.selectedStepIndex = Math.max(0, Number(initialPosition.get("step") ?? 1) - 1)
const initialRowPath = (initialPosition.get("row") ?? "").split(".").filter(Boolean).map(Number)
renderThemeButton()
renderParameterInputs()
renderSweepControls()
setParameters(state.parameters)
selectRowAtPath(initialRowPath)
