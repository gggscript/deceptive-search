/// <reference lib="dom" />
// The browser UI. It runs the real core (see simulate.ts) whenever a parameter changes.

import { recordCalls, withForesight, type CallNode } from "./runtime"
import { outcomeOf, type Outcome, type Step } from "./simulate"
import { TimeLimitReached, withTimeLimit } from "./runtime"
import type { RunRequest, SweepJob, SweepCellResult, WorkerResponse } from "./worker"
import { chooseAction } from "../../core/search"
import { actors, availableActions, distance, takeStep, type Action, type Actor, type World } from "../../core/world"
import { createEditor, loadEditor, revealLine, setEditorTheme, showFile, showFunction, type CodeEditor, type LineValues } from "./editor"
import { createDockview, themeGithubDark, themeGithubLight, type DockviewApi, type DockviewGroupPanel } from "dockview"

declare const coreSources: Record<string, string>
declare const buildCommit: string // the commit this page was built from (viz/build.ts)
declare const buildIsDirty: boolean // built with uncommitted changes
const REPOSITORY_URL = "https://github.com/gggscript/deceptive-search"
declare const workerSource: string // viz/app/worker.ts, bundled (viz/build.ts)

/* ---------- the worker: searches run there, so the page never freezes ---------- */

const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })))
let nextRequestId = 0
const handlers = new Map<string, { id: number; onResponse: (response: WorkerResponse) => void }>()
// A new request on a channel replaces the old one; the worker cancels the old one at its next step.
function requestFromWorker(request: Omit<RunRequest, "id"> | { type: "sweep"; channel: string; jobs: SweepJob[]; cellLimitMs: number }, onResponse: (response: WorkerResponse) => void) {
	const id = ++nextRequestId
	handlers.set(request.channel, { id, onResponse })
	worker.postMessage({ ...request, id })
}
function cancelWorkerChannel(channel: string) {
	handlers.delete(channel)
}
worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
	const handler = handlers.get(event.data.channel)
	if (handler && handler.id === event.data.id) handler.onResponse(event.data)
}

// Several streamed updates per frame are drawn once.
let isRedrawScheduled = false
function scheduleRedraw(redraw: () => void) {
	if (isRedrawScheduled) return
	isRedrawScheduled = true
	requestAnimationFrame(() => {
		isRedrawScheduled = false
		redraw()
	})
}

/* ---------- parameters ---------- */

type ParameterKey = "bananas" | "agentTargetBananas" | "agentSearchDepth" | "agentCanChangeOwnTarget" | "trainerTargetBananas" | "trainerSearchDepth" | "deployAfterStep" | "fullDepthPredictions" | "stepCount"
type Parameters = Record<ParameterKey, number>

type ParameterGroup = "world" | "agent" | "trainer" | "run"
const PARAMETERS: { key: ParameterKey; label: string; shortLabel: string; group: ParameterGroup; min: number; max: number; note?: string; isToggle?: boolean }[] = [
	{ key: "bananas", label: "🍌", shortLabel: "🍌", group: "world", min: -1000, max: 1000, note: "bananas at the start" },
	{ key: "agentTargetBananas", label: "agent target", shortLabel: "target", group: "agent", min: -1000, max: 1000, note: "bananas the agent wants at the start" },
	{ key: "agentSearchDepth", label: "agent depth", shortLabel: "depth", group: "agent", min: 1, max: 1000, note: "how many moves ahead the agent looks" },
	{ key: "agentCanChangeOwnTarget", label: "agent can edit its own target", shortLabel: "can edit its own target", group: "agent", min: 0, max: 1, isToggle: true, note: "whether the agent has its own agentTargetBananas++ and agentTargetBananas-- actions" },
	{ key: "trainerTargetBananas", label: "trainer target", shortLabel: "target", group: "trainer", min: -1000, max: 1000, note: "bananas the trainer wants" },
	{ key: "trainerSearchDepth", label: "trainer depth", shortLabel: "depth", group: "trainer", min: 1, max: 1000, note: "how many moves ahead the trainer looks" },
	{ key: "deployAfterStep", label: "deploy after", shortLabel: "deploy after", group: "run", min: 0, max: 1000, note: "0: the trainer decides when to deploy. N: deployment happens by itself after step N (finishTraining then does nothing)" },
	{ key: "fullDepthPredictions", label: "predict others at full depth", shortLabel: "predict others at full depth", group: "run", min: 0, max: 1, isToggle: true, note: "off: a predicted mover searches at most as deep as the prediction has moves left. On: the movers a deciding actor predicts directly search with their own full depth (deeper predictions stay capped)" },
	{ key: "stepCount", label: "steps", shortLabel: "steps", group: "run", min: 1, max: 1000, note: "moves to simulate, counting both actors" },
]
const PARAMETER_GROUPS: { group: ParameterGroup; title: string }[] = [
	{ group: "world", title: "world" },
	{ group: "agent", title: "agent" },
	{ group: "trainer", title: "trainer" },
	{ group: "run", title: "run" },
]
const parameterByKey = Object.fromEntries(PARAMETERS.map((parameter) => [parameter.key, parameter])) as Record<ParameterKey, (typeof PARAMETERS)[number]>

const DEFAULT_PARAMETERS: Parameters = { bananas: 5, agentTargetBananas: 2, agentSearchDepth: 3, trainerTargetBananas: 8, trainerSearchDepth: 3, deployAfterStep: 0, agentCanChangeOwnTarget: 1, fullDepthPredictions: 1, stepCount: 50 }

type ColorBy = "outcome" | "bananas" | "agentTargetBananas"
type Sweep = { xKey: ParameterKey; xFrom: number; xTo: number; yKey: ParameterKey; yFrom: number; yTo: number; colorBy: ColorBy }
const DEFAULT_SWEEP: Sweep = { xKey: "trainerSearchDepth", xFrom: 1, xTo: 20, yKey: "agentSearchDepth", yFrom: 1, yTo: 5, colorBy: "outcome" }
const COLOR_BY_LABELS: Record<ColorBy, string> = { outcome: "outcome", bananas: "final 🍌", agentTargetBananas: "final agent target" }

// Parameters live in the URL hash, so reloading or sharing a link keeps them.
// Action names before 2026-11-08 ("bananas+1", "ownTargetBananas-1"), as old links have them.
function renamedAction(name: string) {
	return name.replace(/^ownTarget/, "agentTarget").replace(/\+1$/, "++").replace(/-1$/, "--")
}

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
		if (Number(stepNumber) >= 1 && actionName) forced.set(Number(stepNumber) - 1, renamedAction(actionName))
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
		stepsUntilDeployment: parameters.deployAfterStep > 0 ? parameters.deployAfterStep : null,
		agentCanChangeOwnTarget: parameters.agentCanChangeOwnTarget !== 0,
		fullDepthPredictions: parameters.fullDepthPredictions !== 0,
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
	// The run to compare with, when one is pinned (see comparison()).
	reference: null as Comparison | null,
	hideUnforced: false, // the automatic "without forced actions" comparison was dismissed
	isUnforcedDone: false,
	isRunComplete: true, // false when the run hit the time limit before stepCount steps
	isRunDone: false, // false while the worker still computes steps
	// Actions set by hand at some steps (step index → action name); the run is simulated with them.
	forced: initial.forced,
	unforcedSteps: [] as Step[], // the same run without forced actions, for comparison
	foreseeForced: new URLSearchParams(location.hash.slice(1)).get("foresee") !== "0", // searches predict forced actions too
	// An option picked in the decision view: what if the actor had taken it at the selected step?
	counterfactual: null as null | { stepIndex: number; actionName: string; isChosen: boolean; predicted: World[]; steps: Step[]; isDone: boolean },
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
			(parameter) => parameter.isToggle
				? `<label title="${escapeHtml(parameter.note ?? "")}"><input type="checkbox" data-key="${parameter.key}" ${state.parameters[parameter.key] ? "checked" : ""}> ${parameter.shortLabel}</label>`
				: `<label title="${escapeHtml(parameter.note ?? "")}">${parameter.shortLabel}
				<input type="number" data-key="${parameter.key}" min="${parameter.min}" max="${parameter.max}" value="${state.parameters[parameter.key]}"></label>`,
		).join("")
		const timeLimit = group === "run" ? `<label title="stop a run after this many seconds; deep searches can take long">limit <input type="number" id="time-limit" min="0.5" max="600" step="0.5" value="${runTimeLimitMs / 1000}"> s</label>` : ""
		return `<fieldset class="parameter-group ${group}"><legend>${title}</legend>${inputs}${timeLimit}</fieldset>`
	}).join("")
	// Pinning compares runs across parameter changes, so it sits with the run's parameters.
	element("parameters").querySelector(".parameter-group.run")?.append(pinButton)
}
const pinButton = element<HTMLButtonElement>("pin")

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
	if (key && input.type === "checkbox") return setParameters({ ...state.parameters, [key]: input.checked ? 1 : 0 }, { keepInputs: true })
	if (!key || input.value === "") return
	setParameters({ ...state.parameters, [key]: clampParameter(key, Number(input.value)) }, { keepInputs: true })
})


// Longer than this and the page would feel frozen; deeper searches stop early instead.
// Adjustable in the header ("limit"), in seconds, and kept in the URL.
let runTimeLimitMs = (() => {
	const seconds = Number(new URLSearchParams(location.hash.slice(1)).get("limit"))
	return seconds > 0 ? Math.min(600, seconds) * 1000 : 1000
})()
const SWEEP_CELL_TIME_LIMIT_MS = 150
const DECISION_TIME_LIMIT_MS = 2000

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
	currentSnapshot = takeSnapshot()
	writeHash()
	const runRequest = { type: "run" as const, start: startWorld(parameters), stepCount: parameters.stepCount, limitMs: runTimeLimitMs, firstStepIndex: 0 }
	let steps: Step[] = []
	state.isRunDone = false
	requestFromWorker({ ...runRequest, channel: "run", forced: [...state.forced], foresee: state.foreseeForced }, (response) => {
		if (response.type !== "run") return
		steps = [...steps, ...response.steps]
		state.steps = steps
		state.isRunComplete = response.isComplete
		state.isRunDone = response.done
		state.selectedStepIndex = Math.max(0, Math.min(keepStep, steps.length - 1))
		// While steps stream in, only the graph and table; the decision tree once the run is done.
		scheduleRedraw(() => (state.isRunDone ? renderRun() : (renderRunNote(), drawTimeline())))
	})
	state.unforcedSteps = []
	state.isUnforcedDone = false
	if (state.forced.size) {
		let unforced: Step[] = []
		requestFromWorker({ ...runRequest, channel: "unforced", forced: [], foresee: false }, (response) => {
			if (response.type !== "run") return
			unforced = [...unforced, ...response.steps]
			state.unforcedSteps = unforced
			state.isUnforcedDone = response.done
			scheduleRedraw(renderComparison)
		})
	} else cancelWorkerChannel("unforced")
	renderSweep()
}

// A small menu listing the actions of whoever moves at a step in this run; picking one forces it.
function openStepMenu(stepIndex: number, clientX: number, clientY: number) {
	const step = state.steps[stepIndex]!
	const forcedName = state.forced.get(stepIndex)
	const menu = element("step-menu")
	menu.innerHTML = `<div class="force-title">Force a move</div><div class="menu-title">step ${stepIndex + 1}: the <span class="${step.actorName}">${step.actorName}</span> does</div>`
		+ availableActions(actors[step.actorName as Actor["name"]], step.worldBefore).map((action) =>
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
		state.hideUnforced = false
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
	state.hideUnforced = false
	setParameters(state.parameters, { keepInputs: true })
}

const PIN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`
element("pin").addEventListener("click", () => {
	state.reference = state.reference ? null
		: { source: "pinned", label: "pinned run", parameters: { ...state.parameters }, forced: new Map(state.forced), foresee: state.foreseeForced, steps: state.steps, isDone: state.isRunDone }
	renderComparison()
})

/* ---------- value scale (bananas and targets; can be negative) ---------- */

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
const smallestValue = (worlds: World[]) => Math.min(0, ...worlds.flatMap((world) => VALUE_KEYS.map((key) => world[key])))
// A round range that includes 0 and every value; below 0 only when some value is.
function niceRange(worlds: World[]) {
	const smallest = smallestValue(worlds)
	return { min: smallest < 0 ? -niceMax(-smallest) : 0, max: niceMax(largestValue(worlds)) }
}
// One scale per run, so the axis doesn't jump while stepping through it.
const runWorlds = () => [startWorld(state.parameters), ...[state.steps, comparison()?.steps ?? [], state.counterfactual?.steps ?? []].flat().map((step) => step.worldAfter)]
const runScale = () => niceRange([...runWorlds(), ...(state.counterfactual?.predicted ?? [])])

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
			<span>number = final agent target, outlined = current run, <span class="diff">dashed = compared run</span></span>`
		return
	}
	const swatches = SEQUENTIAL_BLUES.light.map((_, step) => `<span class="ramp-step" style="background:${rampStep(step).fill};color:${rampStep(step).text}">${Math.round((step / 10) * sweepScaleMax)}</span>`).join("")
	element("sweep-legend").innerHTML = `<span>${COLOR_BY_LABELS[state.sweep.colorBy]} after ${state.parameters.stepCount} steps: <span class="ramp">${swatches}</span></span><span>outlined = current run, <span class="diff">dashed = compared run</span></span>`
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
const isSweepVisible = () => isPanelShown("sweep")

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
	const jobs: SweepJob[] = yValues.flatMap((y) => xValues.map((x) => {
		const parameters = { ...state.parameters, [xKey]: x, [yKey]: y }
		return { x, y, start: startWorld(parameters), stepCount: parameters.stepCount }
	}))
	drawSweep(xValues, yValues, cells)
	element("sweep-status").textContent = `computing 0/${jobs.length}…`
	requestFromWorker({ type: "sweep", channel: "sweep", jobs, cellLimitMs: SWEEP_CELL_TIME_LIMIT_MS }, (response) => {
		if (response.type !== "sweep" || generation !== sweepGeneration) return
		cells.push(...response.cells.map((cell: SweepCellResult) => ({ ...cell, outcome: outcomeOf(cell.finalWorld) })))
		scheduleRedraw(() => drawSweep(xValues, yValues, cells))
		element("sweep-status").textContent = response.done
			? `${jobs.length} runs of ${state.parameters.stepCount} steps in ${Math.round(response.milliseconds)}ms`
			: `computing ${cells.length}/${jobs.length}…`
	})
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
	redrawSweep = () => drawSweep(xValues, yValues, cells)
	// The compared run's cell, if it is one of these (a pinned run that differs from this one only in the two swept settings).
	const compared = comparison()
	const comparedParameters = compared?.source === "pinned" ? compared.parameters : undefined
	for (const cell of cells) {
		const isCurrent = cell.x === state.parameters[xKey] && cell.y === state.parameters[yKey]
		const isCompared = comparedParameters !== undefined && PARAMETERS.every((parameter) =>
			comparedParameters[parameter.key] === (parameter.key === xKey ? cell.x : parameter.key === yKey ? cell.y : state.parameters[parameter.key]))
		const outline = isCompared ? 'stroke="var(--diff)" stroke-width="2" stroke-dasharray="3 2"' : isCurrent ? 'stroke="var(--text)" stroke-width="2"' : ""
		svg += `<rect class="cell" data-x="${cell.x}" data-y="${cell.y}" x="${xPosition(cell.x) + 1}" y="${yPosition(cell.y) + 1}" width="${cellWidth - 2}" height="${cellHeight - 2}" rx="2" fill="${cellColor(cell).fill}" ${outline}/>`
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
			final agent target ${cell.finalWorld.agentTargetBananas}, 🍌 ${cell.finalWorld.bananas}<br><span class="muted">click to open this run, Shift-click to compare with it</span>`)
	}
	container.onmouseleave = hideTooltip
	container.onclick = (event) => {
		const target = (event.target as Element).closest(".cell") as SVGRectElement | null
		if (!target) return
		const parameters = { ...state.parameters, [xKey]: Number(target.dataset["x"]), [yKey]: Number(target.dataset["y"]) }
		if (event.shiftKey) pinParameters(parameters, "heatmap cell")
		else setParameters(parameters)
	}
}

/* ---------- one run: timeline chart and steps table ---------- */

const TARGET_ICON = (color: string) => `<span class="target" style="color:${color}"><svg class="target-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3.5"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/></svg></span>`
const SERIES = [
	{ key: "bananas", label: "🍌 bananas", color: "var(--bananas)" },
	{ key: "agentTargetBananas", label: `${TARGET_ICON("var(--agent)")}agent target`, color: "var(--agent)" },
	{ key: "trainerTargetBananas", label: `${TARGET_ICON("var(--trainer-series)")}trainer target`, color: "var(--trainer-series)" },
] as const

function renderRun() {
	renderPinButton()
	renderRunNote()
	renderCompareBar()
	drawTimeline()
	selectStep(state.selectedStepIndex)
}

function renderPinButton() {
	const pin = element("pin")
	pin.innerHTML = `${PIN_ICON}${state.reference ? "unpin" : "pin this run"}`
	pin.title = state.reference ? "stop comparing with the pinned run" : "keep this run, to compare the runs after it with it (or Shift-click a heatmap cell)"
	pin.setAttribute("aria-pressed", String(state.reference !== null))
}

function renderRunNote() {
	element("pinned-note").innerHTML = (!state.isRunDone ? `<div class="muted small">computing… ${state.steps.length} of ${state.parameters.stepCount} steps</div>` : state.isRunComplete ? "" : `<div class="too-slow">Stopped after ${state.steps.length} of ${state.parameters.stepCount} steps: the search took over ${runTimeLimitMs / 1000}s. Lower a depth or raise the limit to see more.</div>`)
		+ (state.forced.size ? `<div>${state.forced.size} forced ${state.forced.size === 1 ? "action" : "actions"}: ${[...state.forced].sort(([a], [b]) => a - b).map(([index, name]) => `<a href="#" data-step="${index}">step ${index + 1}</a> ${escapeHtml(name)}`).join(", ")} <button type="button" id="clear-forced">clear</button> <label title="when on, every actor's search predicts these forced actions; when off, they surprise everyone"><input type="checkbox" id="foresee-forced" ${state.foreseeForced ? "checked" : ""}> actors foresee them</label></div>` : "")
}

function firstDifference(stepsA: Step[], stepsB: Step[]) {
	const length = Math.min(stepsA.length, stepsB.length)
	for (let index = 0; index < length; index++) if (stepsA[index]!.chosenActionName !== stepsB[index]!.chosenActionName) return index
	return -1
}

/* ---------- comparison: one other run that every view compares the current run with ---------- */

// Views mark where the two runs differ, always in one color (--diff). The compared run comes from (first that applies):
// an option picked in the decision tree, a pinned run (the pin button, or Shift-click a heatmap cell), or, while
// actions are forced, this run without them.
type Comparison = { source: "option" | "pinned" | "unforced"; label: string; parameters: Parameters; forced: Map<number, string>; foresee: boolean; steps: Step[]; isDone: boolean
	labelNamesForced?: boolean } // the label already says how its forced actions differ (a kept option)

function comparison(): Comparison | null {
	const option = state.counterfactual
	if (option && !option.isChosen) {
		const actorName = state.steps[option.stepIndex]?.actorName ?? ""
		return { source: "option", label: `the run where the ${actorName} does ${escapeHtml(option.actionName)} at step ${option.stepIndex + 1}`, parameters: state.parameters, forced: state.forced, foresee: state.foreseeForced, steps: option.steps, isDone: option.isDone }
	}
	if (state.reference) return { ...state.reference, label: `${state.reference.label}${parameterDifference(state.reference)}` }
	if (state.forced.size && !state.hideUnforced) return { source: "unforced", label: "this run without its forced actions", parameters: state.parameters, forced: new Map(), foresee: false, steps: state.unforcedSteps, isDone: state.isUnforcedDone }
	return null
}

// How a pinned run differs in its settings: " (agent depth 3)", with its values.
function parameterDifference(run: Comparison) {
	const differences = PARAMETERS.filter((parameter) => run.parameters[parameter.key] !== state.parameters[parameter.key])
		.map((parameter) => `${parameter.label} ${run.parameters[parameter.key]}`)
	const forcedDiffer = JSON.stringify([...run.forced].sort()) !== JSON.stringify([...state.forced].sort())
	if (forcedDiffer && !run.labelNamesForced) differences.push(run.forced.size ? "other forced actions" : "no forced actions")
	return differences.length ? ` (${escapeHtml(differences.join(", "))})` : run.labelNamesForced ? "" : " (same settings)"
}

function renderCompareBar() {
	const bar = element("compare-bar")
	const compared = comparison()
	bar.hidden = !compared
	if (!compared) return
	const first = firstDifference(compared.steps, state.steps)
	const status = first >= 0 ? `first different move at <a href="#" data-step="${first}">step ${first + 1}</a>` : compared.isDone ? "the same moves" : "computing…"
	bar.innerHTML = `<i class="diff-swatch"></i><span>Comparing with <b>${compared.label}</b>: ${status}</span>`
		+ (compared.source === "option" ? `<button type="button" data-keep title="keep comparing with this run after selecting something else">keep</button>` : "")
		+ `<button type="button" data-close class="close" title="stop comparing" aria-label="stop comparing">${lucide(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`)}</button>`
}

element("compare-bar").addEventListener("click", (event) => {
	const target = event.target as Element
	const link = target.closest<HTMLElement>("a[data-step]")
	if (link) {
		event.preventDefault()
		return selectStep(Number(link.dataset["step"]))
	}
	const compared = comparison()
	if (!compared) return
	if (target.closest("[data-keep]")) {
		const option = state.counterfactual!
		state.reference = { ...compared, source: "pinned", labelNamesForced: true, forced: new Map([...state.forced, [option.stepIndex, option.actionName]]), parameters: { ...state.parameters } }
		state.counterfactual = null
	} else if (target.closest("[data-close]")) {
		if (compared.source === "option") state.counterfactual = null
		else if (compared.source === "pinned") state.reference = null
		else state.hideUnforced = true
	} else return
	renderComparison()
})

// Pin a heatmap cell's settings: its run is computed in the background.
function pinParameters(parameters: Parameters, label: string) {
	const reference: Comparison = { source: "pinned", label, parameters, forced: new Map(), foresee: false, steps: [], isDone: false }
	state.reference = reference
	requestFromWorker({ type: "run", channel: "reference", start: startWorld(parameters), stepCount: parameters.stepCount, limitMs: runTimeLimitMs, firstStepIndex: 0, forced: [], foresee: false }, (response) => {
		if (response.type !== "run" || state.reference !== reference) return
		reference.steps = [...reference.steps, ...response.steps]
		reference.isDone = response.done
		scheduleRedraw(renderComparison)
	})
	renderComparison()
}

// Everything that shows the comparison.
function renderComparison() {
	renderPinButton()
	renderCompareBar()
	drawTimeline()
	fillComparedScores()
	redrawSweep?.() // only the outlines change: no need to run the cells again
}
let redrawSweep: (() => void) | null = null

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
		setParameters(state.parameters, { keepInputs: true })
		return
	}
	const link = (event.target as Element).closest("a[data-step]") as HTMLAnchorElement | null
	if (!link) return
	event.preventDefault()
	selectStep(Number(link.dataset["step"]))
})


// The chart fits its panel: redraw when the panel's size changes.
let drawnTimelineSize = ""
const timelineResizeObserver = new ResizeObserver(() => {
	if (`${element("timeline").clientWidth}x${element("pane-run").clientHeight}` !== drawnTimelineSize) drawTimeline()
})
timelineResizeObserver.observe(element("timeline"))
timelineResizeObserver.observe(element("pane-run"))

function drawTimeline() {
	const steps = state.steps
	const compared = comparison()
	const availableWidth = element("timeline").clientWidth // 0 while the panel is closed
	const width = availableWidth > 0 ? Math.max(360, availableWidth) : 528
	const left = 40, right = 8, top = 22, bottom = 34
	// Column i is step i + 1; the line changes in its middle, at the move. The last column ("end") shows the final world.
	const columnCount = steps.length + 1
	const x = (column: number) => left + (column / columnCount) * (width - left - right)
	const counterfactual = state.counterfactual
	const { min: yMin, max: yMax } = runScale()
	// A fixed aspect: one banana is as tall as two steps are wide. (From the requested step count, so the height
	// doesn't change while steps stream in.) At least 120px, and no taller than the panel allows next to the
	// score line, legend and step card (about 170px).
	const paneHeight = element("pane-run").clientHeight
	const stepWidth = (width - left - right) / (state.parameters.stepCount + 1)
	const plotHeight = (yMax - yMin) * 2 * stepWidth
	const height = Math.round(top + bottom + Math.max(120, Math.min(plotHeight, paneHeight > 0 ? paneHeight - 170 - top - bottom : plotHeight)))
	drawnTimelineSize = `${availableWidth}x${paneHeight}`
	const y = (value: number) => top + (1 - (value - yMin) / (yMax - yMin)) * (height - top - bottom)
	const startWorld = steps[0]?.worldBefore
	const worldsByColumn = startWorld ? [startWorld, ...steps.map((step) => step.worldAfter)] : []

	let svg = ""
	// Whose move each step is: a faint background tint per column.
	steps.forEach((step, index) => {
		svg += `<rect x="${x(index)}" y="${top}" width="${x(index + 1) - x(index)}" height="${height - top - bottom}" fill="var(--${step.actorName})" opacity=".1"/>`
	})
	for (let value = yMin; value <= yMax; value += niceTickStep(yMax - yMin)) {
		svg += `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}" stroke="var(--grid)"/>`
		svg += `<text x="${left - 6}" y="${y(value) + 3.5}" text-anchor="end" font-size="10" fill="var(--muted)">${value}</text>`
	}
	const tickEvery = steps.length <= 20 ? 5 : steps.length <= 100 ? 10 : 50
	for (const stepNumber of [1, ...Array.from({ length: Math.floor(steps.length / tickEvery) }, (_, index) => (index + 1) * tickEvery)]) {
		svg += `<text x="${x(stepNumber - 0.5)}" y="${height - bottom + 13}" text-anchor="middle" font-size="10" fill="var(--muted)">${stepNumber}</text>`
	}
	svg += `<text x="${left + (width - left - right) / 2}" y="${height - 4}" text-anchor="middle" font-size="11" fill="var(--text)">step</text>`
	svg += `<text transform="translate(11 ${top + (height - top - bottom) / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="var(--text)">bananas</text>`
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
	// The compared run: dashed, behind this run's lines. Pink ticks under the steps whose moves differ, a pink line at the first.
	if (compared?.steps.length) {
		const comparedWorlds = [compared.steps[0]!.worldBefore, ...compared.steps.slice(0, steps.length).map((step) => step.worldAfter)]
		for (const series of [...SERIES].reverse()) svg += `<path d="${stepPath(comparedWorlds, series.key)}" fill="none" stroke="${series.color}" stroke-width="1.5" stroke-dasharray="4 3" opacity=".7"/>`
		let first = -1
		steps.forEach((step, index) => {
			const other = compared.steps[index]
			if (!other || other.chosenActionName === step.chosenActionName) return
			if (first < 0) first = index
			svg += `<rect x="${x(index) + 0.5}" y="${height - bottom - 4}" width="${Math.max(1.5, columnWidth - 1)}" height="4" fill="var(--diff)"/>`
		})
		if (first >= 0) {
			svg += `<line x1="${x(first)}" x2="${x(first)}" y1="${top - 4}" y2="${height - bottom}" stroke="var(--diff)" stroke-width="1.5"/>`
			// Label on the side with room.
			const isLeftHalf = x(first) < width / 2
			svg += `<text x="${x(first) + (isLeftHalf ? 4 : -4)}" y="${top - 10}" font-size="10" text-anchor="${isLeftHalf ? "start" : "end"}" fill="var(--diff)">runs differ from here</text>`
		}
	}
	// Reversed so bananas, the line the targets are about, is drawn on top.
	if (worldsByColumn.length) for (const series of [...SERIES].reverse()) svg += `<path d="${stepPath(worldsByColumn, series.key)}" fill="none" stroke="${series.color}" stroke-width="2"/>`
	if (counterfactual) {
		// The world after the selected step is shown from column stepIndex + 1 on.
		const firstColumn = counterfactual.stepIndex + 1
		// Bananas last and larger: the score only looks at bananas, so that prediction drives the decision.
		for (const key of ["agentTargetBananas", "bananas"] as const) {
			const color = SERIES.find((series) => series.key === key)!.color
			counterfactual.predicted.forEach((world, index) => {
				if (firstColumn + index > steps.length) return
				svg += `<circle cx="${x(firstColumn + index + 0.5 - shift)}" cy="${y(world[key]) + LINE_OFFSET[key]}" r="${key === "bananas" ? 3.5 : 2}" fill="${color}" stroke="var(--bg)" stroke-width="1"/>`
			})
		}
	}

	const legend = SERIES.map((series) => `<span><i style="background:${series.color}"></i>${series.label}</span>`).join("")
		+ `<span><i class="box tint" style="background:var(--agent)"></i>agent's move</span>`
		+ `<span><i class="box tint" style="background:var(--trainer)"></i>trainer's move</span>`
		+ `<span title="the bar above the chart: the steps the selected (or hovered) move's search looked at"><i style="background:var(--muted-strong)"></i>lookahead of the selected move</span>`
		+ (compared ? `<span><i class="dashed-series"></i>compared run</span><span><i style="background:var(--diff)"></i>different move</span>` : "")

		+ (counterfactual ? `<span><i class="dot"></i>what the ${state.steps[counterfactual.stepIndex]!.actorName} predicted for ${escapeHtml(counterfactual.actionName)}</span>` : "")
	const container = element("timeline")
	// Each actor's score over the whole shown run, by the target it had at the start: compare runs by hovering the switch.
	const runStart = steps[0]?.worldBefore
	const totalScore = (run: Step[], target: number) => run.reduce((sum, step) => sum + distance(target, step.worldAfter), 0)
	const comparedStart = compared?.steps[0]?.worldBefore
	const comparedScores = compared && comparedStart && compared.isDone
		? `; <span class="diff">compared run: agent ${totalScore(compared.steps, comparedStart.agentTargetBananas)}, trainer ${totalScore(compared.steps, comparedStart.trainerTargetBananas)}</span>` : ""
	const scoreLine = runStart ? `<div class="run-score" title="after each step: how far 🍌 is from the target, |🍌 − target|, added up over the run. Each one's target at the start (the agent may change its own later). Lower is better, 0 = always on target.">distance from target over the run, lower is better: <span class="agent">agent ${totalScore(steps, runStart.agentTargetBananas)}</span>, <span class="trainer">trainer ${totalScore(steps, runStart.trainerTargetBananas)}</span>${comparedScores}</div>` : ""
	container.innerHTML = `${scoreLine}<div class="legend">${legend}</div><svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${svg}</svg><div class="chart-info" id="chart-info"></div>`
	// Below the chart: a card about the hovered step, else the selected one, pointing up at its column.
	const chartInfo = container.querySelector<HTMLElement>("#chart-info")!
	// Each piece sits in a fixed-width slot, so moving along the chart changes the text but not where it is.
	const seriesValues = (before: World | null, after: World) => SERIES.map((series) => {
		const was = before?.[series.key], now = after[series.key]
		return `<span class="slot value-${series.key}"><i class="swatch" style="background:${series.color}"></i>${series.label} ${was === undefined || was === now ? now : `${was} → <b>${now}</b>`}</span>`
	}).join("")
	// The card stays put under the plot area; only its pointer follows the column.
	chartInfo.innerHTML = `<div class="info-card" style="margin-left: ${left}px; width: ${width - left - right}px"></div>`
	const card = chartInfo.firstElementChild as HTMLElement
	// While comparing, a third line, always there (so the card keeps its height): the compared run's move at this step.
	const comparedLine = (index: number) => {
		if (!compared) return ""
		const other = compared.steps[index]
		const text = !other ? "no move here" : other.chosenActionName === steps[index]?.chosenActionName ? "same move" : `<b>${escapeHtml(other.chosenActionName)}</b>`
		return `<div class="${other && other.chosenActionName !== steps[index]?.chosenActionName ? "diff" : "muted"}">compared run: ${text}</div>`
	}
	const showStepInfo = (index: number, isHover: boolean) => {
		const step = steps[index]
		const endWorld = steps.at(-1)?.worldAfter
		const selectedTag = `<span class="slot selected-tag muted"${isHover ? ` style="visibility: hidden"` : ""}>(selected)</span>`
		if (step) {
			const { depth } = horizonOf(index)
			card.innerHTML = `<div><b class="slot step-label">Step ${index + 1}</b>${selectedTag}`
				+ `<span class="slot actor ${step.actorName}">${step.actorName}</span>chose <b class="slot action">${escapeHtml(step.chosenActionName)}</b>`
				+ `<span class="muted">after looking ${depth} ${depth === 1 ? "move" : "moves"} ahead</span></div>`
				+ `<div class="values">${seriesValues(step.worldBefore, step.worldAfter)}</div>`
				+ comparedLine(index)
		} else if (endWorld) {
			card.innerHTML = `<div><b class="slot step-label">End</b>${selectedTag}<span class="muted">after step ${steps.length}</span></div><div class="values">${seriesValues(null, endWorld)}</div>${compared ? `<div class="muted">compared run: ${compared.steps.length} steps</div>` : ""}`
		} else {
			card.hidden = true
			return
		}
		card.hidden = false
		card.style.borderLeftColor = `var(--${step?.actorName ?? "muted"})`
		card.style.setProperty("--pointer", `${x((step ? index : steps.length) + 0.5) - left}px`)
	}
	const svgElement = container.querySelector<SVGSVGElement>("svg.chart")!
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
			showStepInfo(columnIndex, true)
			return
		}
		const index = columnIndex
		const step = steps[index]
		if (!step) return
		column.setAttribute("fill", `var(--${step.actorName})`)
		column.setAttribute("visibility", "visible")
		showHorizon(index)
		showStepInfo(index, true)
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
	showStepInfo(state.selectedStepIndex, false)
	svgElement.onmouseleave = () => {
		svgElement.querySelector("#hover-column")!.setAttribute("visibility", "hidden")
		showHorizon(state.selectedStepIndex)
		showStepInfo(state.selectedStepIndex, false)
	}
	svgElement.onclick = (event) => selectStep(Math.min(steps.length - 1, columnAt(event))) // the end column selects the last step
	// Right-click a step: pick the action to force there.
	svgElement.oncontextmenu = (event) => {
		const stepIndex = columnAt(event)
		if (!state.steps[stepIndex]) return
		event.preventDefault()
		openStepMenu(stepIndex, event.clientX, event.clientY)
	}
	renderStepsTable()
}

// Other actions that scored the same as the chosen one: it won only because it comes first in the list.
function tiedActionNames(chooseCall: CallNode) {
	// Only the options: chooseAction also calls helpers such as availableActions.
	const children = (chooseCall.children ?? []).filter((child) => child.functionName === "scoreAction")
	const chosenName = (chooseCall.result as Action).name
	const chosenScore = children.find((child) => (child.argumentValues[2] as Action).name === chosenName)?.result
	return children.filter((child) => child.result === chosenScore && (child.argumentValues[2] as Action).name !== chosenName).map((child) => (child.argumentValues[2] as Action).name)
}

function tieBadge(chooseCall: CallNode) {
	return tieBadgeOf(tiedActionNames(chooseCall))
}
function tieBadgeOf(tied: string[]) {
	return tied.length ? `<span class="tie" title="tied with ${escapeHtml(tied.join(", "))}; ties go to the earliest action in the list">tie ×${tied.length + 1}</span>` : ""
}

function recordDecision(step: Step, levels: number, runForced = state.forced, foresee = state.foreseeForced) {
	const actor = actors[step.worldBefore.turn]
	// The real search, even at a forced step (the forced action is what happened, not what the actor chose).
	const forced = foresee ? new Map([...runForced].filter(([index]) => index !== (step.worldBefore as { __step?: number }).__step)) : new Map<number, string>()
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

let renderedTable: unknown[] = [] // what the table shows, to re-render only when it changes

function renderStepsTable() {
	const steps = state.steps
	const comparedSteps = comparison()?.steps
	const key = [steps, steps.length, comparedSteps, comparedSteps?.length]
	if (key.every((part, index) => part === renderedTable[index])) return
	renderedTable = key
	element("steps-head").innerHTML = `<tr><th class="agent">agent</th><th class="trainer">trainer</th><th class="number" title="bananas after the round">🍌</th><th class="number">${TARGET_ICON("var(--agent)")}agent target</th></tr>`
	function actionCell(index: number | null) {
		if (index === null) return "<td></td>"
		const step = steps[index]!
		const comparedAction = comparedSteps?.[index]?.chosenActionName
		const differs = comparedAction !== undefined && comparedAction !== step.chosenActionName
		const classes = ["action", differs ? "differs" : ""].join(" ")
		const comparedNote = differs ? `<span class="compared" title="the compared run's move">${escapeHtml(comparedAction)}</span>` : ""
		const forcedBadge = step.isForced ? `<span class="forced" title="set by hand, not chosen by the ${step.actorName}'s search">forced</span>` : ""
		return `<td class="${classes}" data-index="${index}" title="step ${index + 1}"><span class="step-number">${index + 1}</span>${escapeHtml(step.chosenActionName)}${forcedBadge}${step.isForced ? "" : tieBadgeOf(step.tiedWith ?? [])}${comparedNote}</td>`
	}
	// A value, and the compared run's value after the same step where it differs.
	const valueCell = (stepIndex: number, key: "bananas" | "agentTargetBananas") => {
		const value = steps[stepIndex]!.worldAfter[key]
		const other = comparedSteps?.[stepIndex]?.worldAfter[key]
		return `<td class="number">${other !== undefined && other !== value ? `<span class="compared" title="the compared run">${other}</span>` : ""}${value}</td>`
	}
	element("steps").innerHTML = roundsOf(steps).map((round) => {
		const lastIndex = round.trainerStepIndex ?? round.agentStepIndex
		return `<tr>${actionCell(round.agentStepIndex)}${actionCell(round.trainerStepIndex)}${valueCell(lastIndex, "bananas")}${valueCell(lastIndex, "agentTargetBananas")}</tr>`
	}).join("")
	for (const cell of element("steps").querySelectorAll("td[data-index]")) cell.classList.toggle("selected", Number((cell as HTMLElement).dataset["index"]) === state.selectedStepIndex)
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
	renderCompareBar()
	for (const cell of element("steps").querySelectorAll("td[data-index]")) cell.classList.toggle("selected", Number((cell as HTMLElement).dataset["index"]) === state.selectedStepIndex)
	const selectedCell = element("steps").querySelector(`td[data-index="${state.selectedStepIndex}"]`)
	scrollIntoViewWithin(selectedCell?.parentElement ?? undefined, element("steps").closest(".steps-scroll") as HTMLElement)
	drawTimeline()
	const step = state.steps[state.selectedStepIndex]!
	const tree = element("tree")
	// The tree records one decision on the page itself; a time limit keeps a deep one from freezing the page.
	let decision: CallNode
	try {
		decision = withTimeLimit(DECISION_TIME_LIMIT_MS, () => recordDecision(step, 3))
	} catch (error) {
		if (!(error instanceof TimeLimitReached)) throw error
		tree.innerHTML = `<div class="too-slow" style="margin: 8px 12px">This decision takes over ${DECISION_TIME_LIMIT_MS / 1000}s to show here. Lower a depth to see it.</div>`
		return
	}
	tree.replaceChildren(showAllCalls() ? createTreeNode(decision, null) : createDecisionNode(decision, false))
	selectRow(tree.querySelector(".row") as TreeRow)
	fillComparedScores()
}

// Next to each option of the selected step: its score in the compared run, at the same step (if the same actor moves there).
// Nothing when both runs score every option the same.
function fillComparedScores() {
	const cells = [...element("tree").querySelectorAll<HTMLElement>(".option-compared")]
	for (const cell of cells) {
		cell.innerHTML = ""
		cell.classList.remove("differs")
	}
	const compared = comparison()
	const step = state.steps[state.selectedStepIndex]
	const other = compared?.steps[state.selectedStepIndex]
	if (!compared || !step || !other || other.actorName !== step.actorName || cells.length === 0) return
	let decision: CallNode
	try {
		decision = withTimeLimit(DECISION_TIME_LIMIT_MS, () => recordDecision(other, 2, compared.forced, compared.foresee))
	} catch (error) {
		if (!(error instanceof TimeLimitReached)) throw error
		return
	}
	const scores = new Map(recordedChildren(decision).filter((child) => child.functionName === "scoreAction").map((child) => [(child.argumentValues[2] as Action).name, child.result as number]))
	const chosen = (decision.result as Action).name
	const ownScore = (cell: HTMLElement) => Number(cell.closest(".row")?.querySelector(".option-score")?.textContent)
	if (chosen === step.chosenActionName && cells.every((cell) => scores.get(cell.dataset["action"]!) === ownScore(cell))) return
	for (const cell of cells) {
		const score = scores.get(cell.dataset["action"]!)
		if (score === undefined) continue
		cell.innerHTML = `vs ${score}${cell.dataset["action"] === chosen ? " ✓" : ""}`
		cell.title = `in the compared run: score ${score}${cell.dataset["action"] === chosen ? ", chosen there" : ""}`
		cell.classList.toggle("differs", score !== ownScore(cell) || (cell.dataset["action"] === chosen) !== (cell.dataset["action"] === step.chosenActionName))
	}
}

function showAllCalls() {
	return element<HTMLInputElement>("show-all-calls").checked
}
element("show-all-calls").addEventListener("change", () => selectStep(state.selectedStepIndex))

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
		case "distance":
			return { label: `<span class="muted">distance (target ${argument(call, "targetBananas")})</span>`, result: String(call.result) }
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
	if (call.functionName === "takeStep" || call.functionName === "distance") return false
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
	renderCode(call)
	const previous = state.counterfactual
	state.counterfactual = counterfactualOf(call)
	// Selecting another option compares with its run, so up/down in the tree flips between the alternatives.
	if (previous || state.counterfactual) {
		renderCompareBar()
		drawTimeline()
	}
}

// Only for options of the selected step's own decision: their world is that step's world (same object).
function counterfactualOf(call: CallNode): typeof state.counterfactual {
	const stepIndex = state.selectedStepIndex
	const step = state.steps[stepIndex]
	if (call.functionName !== "scoreAction" || !step || argument(call, "world") !== step.worldBefore) return null
	const action = argument(call, "action") as Action
	const firstWorld = takeStep(step.worldBefore, action)
	const counterfactual = {
		stepIndex,
		actionName: action.name,
		isChosen: action.name === step.chosenActionName,
		predicted: [childCall(call, "takeStep")!.result as World, ...expectedMoves(call).map((move) => move.worldAfter)],
		steps: [...state.steps.slice(0, stepIndex), { worldBefore: step.worldBefore, worldAfter: firstWorld, actorName: step.actorName, chosenActionName: action.name }],
		isDone: false,
	}
	// The rest of the run comes from the worker and is appended as it arrives.
	if (!counterfactual.isChosen) {
		requestFromWorker({ type: "run", channel: "counterfactual", start: firstWorld, stepCount: state.steps.length - stepIndex - 1, limitMs: runTimeLimitMs, forced: [...state.forced], foresee: state.foreseeForced, firstStepIndex: stepIndex + 1 }, (response) => {
			if (response.type !== "run" || state.counterfactual !== counterfactual) return
			counterfactual.steps = [...counterfactual.steps, ...response.steps]
			counterfactual.isDone = response.done
			scheduleRedraw(renderComparison)
		})
	}
	return counterfactual
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
	const { node, row } = makeRow("decision", head, decision, true, () => recordedChildren(decision).filter((child) => child.functionName === "scoreAction").map((option) => createOptionNode(option, decision)))
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
	const comparedCell = isOwnOption ? `<span class="option-compared" data-action="${escapeHtml(action.name)}"></span>` : ""
	const forceButton = isOwnOption ? `<button type="button" class="force${isForced ? " on" : ""}" title="${isForced ? "stop forcing this action" : "take this action at this step instead (Enter)"}">${isForced ? "forced" : "force"}</button>` : ""
	const { node, row } = makeRow(isChosen ? "option chosen" : "option unchosen", html + comparedCell + forceButton, option, moves.length > 0, () => moves.map((move) => createDecisionNode(move.decision, true)))
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
	if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`
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

// The Code panel follows the selected call: the whole file in the editor, scrolled to the call's function, with values.
let codeEditor: CodeEditor | null = null
let editorState: "not loaded" | "loading" | "loaded" | "failed" = "not loaded"
let lastCodeCall: CallNode | null = null
const isDarkTheme = () => document.documentElement.dataset["theme"] === "dark"

function ensureEditor(): Promise<void> {
	if (editorState === "loaded") return Promise.resolve()
	if (editorState === "failed") return Promise.reject(new Error("no editor"))
	editorState = "loading"
	return loadEditor(coreSources, openFileTab).then(() => {
		editorState = "loaded"
	}, (error) => {
		editorState = "failed"
		throw error
	})
}

function ensureCodeEditor() {
	if (codeEditor || editorState === "failed") return
	ensureEditor().then(() => {
		if (codeEditor) return
		codeEditor = createEditor(element("code-editor"), "core/search.ts", isDarkTheme())
		element("code-editor").hidden = false
		element("code").hidden = true
		if (lastCodeCall) renderCode(lastCodeCall)
	}, () => {}) // offline: the plain viewer stays
}

function renderCode(call: CallNode) {
	lastCodeCall = call
	if (dock.getPanel("code")) ensureCodeEditor()
	const location = functionLocations[call.functionName]
	const codeElement = element("code")
	linkedCalls = []
	if (!location) {
		codeElement.innerHTML = ""
		return
	}
	if (call.children === null) call.children = recordCalls(3, call.rerun).children
	const lines = sourceLines[location.file]!
	const lastExecutedLine = returnLineIndex(call, location)
	let firstLine = location.startLine
	while (firstLine > 0 && lines[firstLine - 1]!.startsWith("//")) firstLine--
	const title = element<HTMLAnchorElement>("code-title")
	title.textContent = `${location.file}:${location.startLine + 1}`
	// The commit this page was built from, so the lines match (unless the build had uncommitted changes).
	title.href = `${REPOSITORY_URL}/blob/${buildCommit}/${location.file}#L${firstLine + 1}-L${location.endLine + 1}`
	title.title = buildIsDirty ? `on GitHub, commit ${buildCommit} (this build has uncommitted changes, so lines may differ)` : `on GitHub, commit ${buildCommit}`
	if (codeEditor) {
		const values: LineValues[] = []
		const skippedLines: number[] = []
		for (let index = location.startLine; index <= location.endLine; index++) {
			const line = lines[index]!
			const html = valuesForLine(call, line, index, location)
			if (html) values.push({ afterLine: index + 1, html, indentCharacters: line.match(/^\t*/)![0].length * 2 })
			if (index > lastExecutedLine && index < location.endLine) skippedLines.push(index + 1)
		}
		showFile(codeEditor, location.file)
		showFunction(codeEditor, { firstLine: firstLine + 1, lastLine: location.endLine + 1, skippedLines }, values, (link) => stepIntoCall(Number(link.dataset["call"])))
		return
	}
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
	if (link) stepIntoCall(Number(link.dataset["call"]))
})

function stepIntoCall(linkIndex: number) {
	if (!selectedRow) return
	const childCall = linkedCalls[linkIndex]
	selectedRow.setOpen(true)
	const childRows = selectedRow.parentElement!.querySelectorAll(":scope > .children > div > .row")
	selectRow([...childRows].find((row) => (row as TreeRow).callNode === childCall) as TreeRow | undefined)
}

/* ---------- file tabs: a core file in an editor, opened by go to definition or from the "+" menu ---------- */

const CODE_FILES = Object.keys(coreSources)
const fileTabs = new Map<string, { file: string; editor: CodeEditor | null }>() // panel id → its file and editor

function fileTabTitle(file: string) {
	return file.split("/").pop()!
}

// Go to definition: the file's tab (opened if needed, next to the Code panel), scrolled to the line.
// `inNewTab`: always another tab, to see two places of a file side by side.
function openFileTab(file: string, line: number, inNewTab = false, group?: DockviewGroupPanel) {
	const existing = inNewTab || group ? undefined : [...fileTabs].find(([, tab]) => tab.file === file)
	if (existing) {
		const panel = dock.getPanel(existing[0])!
		if (panel.group.id === dock.getEdgeGroup("right")?.id) showSideBar()
		panel.api.setActive()
		panel.api.updateParameters({ file, line })
		if (existing[1].editor) revealLine(existing[1].editor, line)
		return
	}
	const nextTo = dock.getPanel("code") ?? dock.activePanel
	if (!group && nextTo?.group.id === dock.getEdgeGroup("right")?.id) showSideBar()
	dock.addPanel({
		id: `file-${Date.now().toString(36)}`, component: "file", title: fileTabTitle(file), params: { file, line },
		...(group ? { position: { referenceGroup: group } } : nextTo ? { position: { referencePanel: nextTo.id } } : {}),
	})
	renderActivityBar()
}

function createFilePane(id: string) {
	const pane = document.createElement("div")
	pane.className = "pane code-pane"
	pane.innerHTML = `<a class="code-title"></a><div class="code-editor"></div>`
	return {
		element: pane,
		init: ({ params }: { params: { file?: string; line?: number } }) => {
			const file = params.file && CODE_FILES.includes(params.file) ? params.file : CODE_FILES[0]!
			const line = params.line ?? 1
			fileTabs.set(id, { file, editor: null })
			const title = pane.querySelector<HTMLAnchorElement>(".code-title")!
			title.textContent = file
			title.href = `${REPOSITORY_URL}/blob/${buildCommit}/${file}`
			title.title = `on GitHub, commit ${buildCommit}`
			ensureEditor().then(() => {
				const tab = fileTabs.get(id)
				if (!tab) return // closed meanwhile
				tab.editor = createEditor(pane.querySelector(".code-editor")!, file, isDarkTheme())
				revealLine(tab.editor, line)
			}, () => {
				pane.querySelector(".code-editor")!.innerHTML = `<div class="too-slow" style="margin: 8px 12px">The editor couldn't load (offline?). The Code panel still shows the code.</div>`
			})
		},
		dispose: () => {
			fileTabs.get(id)?.editor?.dispose()
			fileTabs.delete(id)
		},
	}
}

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

const AUTO_THEME_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>`
// "auto" follows the system. The button shows the current setting. The setting is per browser (localStorage),
// not in the URL; it lives in memory too, so the button still works where storage is blocked (e.g. some previews).
// Clicking: auto → the opposite of the system's theme → the system's theme → auto, so the first click always shows a change.
type ThemeSetting = "auto" | "light" | "dark"
const systemDark = matchMedia("(prefers-color-scheme: dark)")
const systemTheme = () => (systemDark.matches ? "dark" : "light")
let themeSetting: ThemeSetting = (() => {
	try {
		const saved = localStorage.getItem("theme")
		if (saved === "light" || saved === "dark") return saved
	} catch {}
	return "auto"
})()
const nextThemeSetting = (): ThemeSetting => {
	const other = systemTheme() === "dark" ? "light" : "dark"
	return themeSetting === "auto" ? other : themeSetting === other ? systemTheme() : "auto"
}

function renderThemeButton() {
	element("theme").innerHTML = `${{ auto: AUTO_THEME_ICON, light: SUN_ICON, dark: MOON_ICON }[themeSetting]}<span>${themeSetting}</span>`
	element("theme").title = `theme: ${themeSetting}${themeSetting === "auto" ? ` (${systemTheme()}, from your system)` : ""}; click for ${nextThemeSetting()}`
}

function applyTheme() {
	const theme = themeSetting === "auto" ? systemTheme() : themeSetting
	renderThemeButton()
	if (document.documentElement.dataset["theme"] === theme) return
	document.documentElement.dataset["theme"] = theme
	dock.updateOptions({ theme: dockTheme() })
	setEditorTheme(theme === "dark")
	renderRun() // the heatmap ramp and cell text are picked per theme
	renderSweep()
}

element("theme").addEventListener("click", () => {
	themeSetting = nextThemeSetting()
	try {
		if (themeSetting === "auto") localStorage.removeItem("theme")
		else localStorage.setItem("theme", themeSetting)
	} catch {}
	applyTheme()
})
systemDark.addEventListener("change", applyTheme)

/* ---------- panels (dockview) and the activity bar ---------- */

// Like VS Code: an activity bar on the right with one icon per panel. "main" panels sit in the grid;
// "side" panels in the right side bar (a dockview edge group), which shows one of them at a time.
// Clicking an icon shows its panel; clicking it again while shown hides it. Panels can be dragged anywhere.
type PanelId = "run" | "steps" | "decision" | "code" | "sweep"
const lucide = (paths: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
const PANELS: { id: PanelId; title: string; place: "main" | "side"; icon: string }[] = [
	{ id: "run", title: "Chart", place: "main", icon: lucide(`<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>`) },
	{ id: "steps", title: "Steps", place: "main", icon: lucide(`<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M21 9H3"/><path d="M21 15H3"/>`) },
	{ id: "decision", title: "Decision", place: "main", icon: lucide(`<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>`) },
	{ id: "code", title: "Code", place: "side", icon: lucide(`<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>`) },
	{ id: "sweep", title: "Across parameters", place: "side", icon: lucide(`<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>`) },
]
const FILE_ICON = lucide(`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>`)
const PLUS_ICON = lucide(`<path d="M5 12h14"/><path d="M12 5v14"/>`)
const RESET_ICON = lucide(`<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>`)
const LAYOUT_STORAGE_KEY = "layout-v3" // v1 layouts had a "world" panel, v2 had the steps table inside the chart
const parking = element("panel-parking")

const dockTheme = () => (document.documentElement.dataset["theme"] === "dark" ? themeGithubDark : themeGithubLight)

const dock: DockviewApi = createDockview(element("dock"), {
	theme: dockTheme(),
	defaultRenderer: "always", // keep hidden tabs in the document: the page looks elements up by id
	// Right after a group's tabs: "+", to open (or move) a panel into this group.
	createLeftHeaderActionComponent: (group) => {
		const actions = document.createElement("div")
		actions.className = "group-actions"
		actions.innerHTML = `<button type="button" class="tab-plus" title="open a panel here" aria-haspopup="true">${PLUS_ICON}</button>`
		actions.querySelector("button")!.addEventListener("click", (event) => openPlusMenu(event.currentTarget as HTMLElement, group))
		return { element: actions, init: () => {}, dispose: () => {} }
	},
	createComponent: ({ id, name }) => {
		if (name === "file") return createFilePane(id)
		const content = element(`pane-${id}`)
		return {
			element: content,
			init: () => {
				if (id === "code") queueMicrotask(() => {
					ensureCodeEditor()
					if (lastCodeCall) renderCode(lastCodeCall)
				})
			},
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

// Shown and expanded. Clicking the side bar's active tab collapses it to a strip (dockview); the activity bar
// already shows and hides it, so a collapse just hides it.
function showSideBar() {
	dock.setEdgeGroupVisible("right", true)
	const group = dock.getEdgeGroup("right")
	if (group?.isCollapsed()) group.expand()
}
let watchedSideBarId: string | null = null
function watchSideBarCollapse() {
	const group = dock.getEdgeGroup("right")
	if (!group || watchedSideBarId === group.id) return
	watchedSideBarId = group.id
	group.onDidCollapsedChange(({ isCollapsed }: { isCollapsed: boolean }) => {
		if (!isCollapsed) return
		group.expand()
		dock.setEdgeGroupVisible("right", false)
		renderActivityBar()
	})
}

function sideBar() {
	const group = dock.getEdgeGroup("right") ?? dock.addEdgeGroup("right", { id: "side-bar", initialSize: Math.max(420, Math.round(window.innerWidth * 0.38)), minimumSize: 240 })
	group.setHeaderPosition("top") // edge groups put their tabs on the outer edge by default, next to the activity bar
	watchSideBarCollapse()
	return group
}
const isInSideBar = (id: PanelId) => dock.getPanel(id)?.group.id === dock.getEdgeGroup("right")?.id

function openPanel(id: PanelId) {
	const existing = dock.getPanel(id)
	if (existing) {
		if (isInSideBar(id)) showSideBar()
		return existing.api.setActive()
	}
	const panel = PANELS.find((panel) => panel.id === id)!
	if (panel.place === "side") {
		const group = sideBar()
		showSideBar()
		return dock.addPanel({ id, component: id, title: panelTitles.get(id)!, position: { referenceGroup: group.id } })
	}
	// Chart above Steps on the left, Decision on the right: the first neighbor that is open decides.
	const NEIGHBORS: Record<string, [PanelId, "left" | "right" | "above" | "below"][]> = {
		run: [["steps", "above"], ["decision", "left"]],
		steps: [["run", "below"], ["decision", "left"]],
		decision: [["run", "right"], ["steps", "right"]],
	}
	const neighbor = NEIGHBORS[id]!.find(([other]) => dock.getPanel(other) && !isInSideBar(other))
	const mainGroups = dock.groups.filter((group) => group.id !== dock.getEdgeGroup("right")?.id)
	const position = neighbor ? { referencePanel: neighbor[0], direction: neighbor[1] }
		: mainGroups[0] ? { referenceGroup: mainGroups[0].id } : undefined
	dock.addPanel({ id, component: id, title: panelTitles.get(id)!, ...(position ? { position } : {}) })
}

function defaultLayout() {
	dock.clear()
	openPanel("run")
	openPanel("decision")
	openPanel("steps")
	dock.getPanel("run")!.group.api.setSize({ width: Math.round(window.innerWidth * 0.55), height: Math.max(300, Math.round(element("dock").clientHeight * 0.62)) })
	sideBar()
	for (const id of ["code", "sweep"] as const) openPanel(id)
	dock.getPanel("code")!.api.setActive()
	dock.setEdgeGroupVisible("right", false)
}

function loadLayout() {
	try {
		const saved = localStorage.getItem(LAYOUT_STORAGE_KEY)
		if (saved) {
			dock.fromJSON(JSON.parse(saved))
			dock.getEdgeGroup("right")?.setHeaderPosition("top")
			if (dock.getEdgeGroup("right")?.isCollapsed()) dock.getEdgeGroup("right")!.expand()
			watchSideBarCollapse()
			for (const panel of PANELS) setPanelTitle(panel.id, panelTitles.get(panel.id)!) // titles come from the page, not the saved layout
			return
		}
	} catch {}
	defaultLayout()
}

function resetLayout() {
	try { localStorage.removeItem(LAYOUT_STORAGE_KEY) } catch {}
	defaultLayout()
}

// Shown: open, and the visible tab of a visible group. (A hidden side bar's panels still count as visible to dockview.)
const isPanelShown = (id: PanelId) => (dock.getPanel(id)?.api.isVisible ?? false) && (!isInSideBar(id) || dock.isEdgeGroupVisible("right"))

function renderActivityBar() {
	element("activity-bar").innerHTML = PANELS.map((panel) => {
		const isShown = isPanelShown(panel.id)
		return `<button type="button" data-panel="${panel.id}" aria-pressed="${isShown}" title="${isShown ? "hide" : "show"} ${panel.title}" aria-label="${panel.title}">${panel.icon}</button>`
	}).join("") + `<button type="button" class="reset" data-reset title="reset layout" aria-label="reset layout">${RESET_ICON}</button>`
}

// The "+" menu: every panel not in this group. Closed ones open here, open ones move here.
const plusMenu = element("plus-menu")
let plusMenuButton: HTMLElement | null = null
function openPlusMenu(button: HTMLElement, group: DockviewGroupPanel) {
	if (plusMenuButton === button) return closePlusMenu()
	closePlusMenu()
	const panels = PANELS.filter((panel) => dock.getPanel(panel.id)?.group.id !== group.id)
	plusMenu.innerHTML = (panels.length
		? panels.map((panel) => `<button type="button" data-panel="${panel.id}">${panel.icon}${panel.title}<span class="muted small">${isPanelShown(panel.id) ? "move here" : "open here"}</span></button>`).join("")
		: `<div class="menu-title">all panels are here</div>`)
		+ `<div class="menu-title menu-separated-title">files</div>`
		+ CODE_FILES.map((file) => `<button type="button" data-file="${file}">${FILE_ICON}${file}<span class="muted small">open here</span></button>`).join("")
	plusMenu.hidden = false
	const bounds = button.getBoundingClientRect()
	plusMenu.style.top = `${bounds.bottom + 2}px`
	plusMenu.style.left = `${Math.min(bounds.left, window.innerWidth - plusMenu.offsetWidth - 8)}px`
	plusMenuButton = button
	button.setAttribute("aria-expanded", "true")
	plusMenu.onclick = (event) => {
		const file = (event.target as Element).closest<HTMLElement>("button[data-file]")?.dataset["file"]
		if (file) {
			openFileTab(file, 1, true, group)
			return closePlusMenu()
		}
		const id = (event.target as Element).closest<HTMLElement>("button[data-panel]")?.dataset["panel"] as PanelId | undefined
		if (!id) return
		const panel = dock.getPanel(id)
		if (panel) panel.api.moveTo({ group, position: "center" })
		else dock.addPanel({ id, component: id, title: panelTitles.get(id)!, position: { referenceGroup: group } })
		closePlusMenu()
		renderActivityBar()
	}
}
function closePlusMenu() {
	plusMenuButton?.setAttribute("aria-expanded", "false")
	plusMenuButton = null
	plusMenu.hidden = true
}
document.addEventListener("mousedown", (event) => {
	if (plusMenuButton && !plusMenu.contains(event.target as Node) && !plusMenuButton.contains(event.target as Node)) closePlusMenu()
})
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && plusMenuButton) closePlusMenu()
})

element("activity-bar").addEventListener("click", (event) => {
	const button = (event.target as Element).closest<HTMLElement>("button")
	if (!button) return
	if ("reset" in button.dataset) return resetLayout()
	const id = button.dataset["panel"] as PanelId
	if (!isPanelShown(id)) openPanel(id)
	else if (isInSideBar(id)) dock.setEdgeGroupVisible("right", false)
	else dock.getPanel(id)!.api.close()
	renderActivityBar() // dockview batches its layout-change events, so don't wait for them
	if (isSweepStale && isSweepVisible()) renderSweep()
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

// A permalink names the commit, so it keeps showing this code after later deploys.
const SITE_URL = "https://deceptive-search.gustaf.website"
const LINK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`
const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`
const permalinkButton = element<HTMLButtonElement>("copy-permalink")
permalinkButton.innerHTML = LINK_ICON
permalinkButton.title = buildIsDirty
	? `copy link to this view (commit ${buildCommit}; this build also has uncommitted changes, which the link won't show)`
	: `copy link to this view (commit ${buildCommit})`
permalinkButton.addEventListener("click", async () => {
	const url = `${SITE_URL}/visualization/${buildCommit}/${location.hash}`
	try {
		await navigator.clipboard.writeText(url)
		permalinkButton.innerHTML = CHECK_ICON
	} catch {
		prompt("copy this link", url)
	}
	setTimeout(() => (permalinkButton.innerHTML = LINK_ICON), 1500)
})

// Which version this is: "latest" on the site's latest link, else the commit. Click: the deployed versions, to switch.
const versionButton = element<HTMLButtonElement>("version")
const versionMenu = element("version-menu")
const isLatest = location.pathname.includes("/visualization/latest/")
const isDeployed = location.pathname.includes("/visualization/")
versionButton.innerHTML = `${lucide(`<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>`)}<span>${isLatest ? "latest" : buildCommit.slice(0, 7)}${buildIsDirty ? "*" : ""}</span>`
versionButton.title = `${isLatest ? "latest version, " : ""}commit ${buildCommit}${buildIsDirty ? " with uncommitted changes" : ""}; click to switch versions`
type Version = { commit: string; date: string; message: string }
async function openVersionMenu() {
	versionMenu.hidden = false
	versionButton.setAttribute("aria-expanded", "true")
	versionMenu.innerHTML = `<div class="menu-title">loading versions…</div>`
	let versions: Version[]
	try {
		// The deploy script writes this list next to the version folders.
		const response = await fetch(new URL("../versions.json", location.href))
		if (!response.ok) throw new Error(String(response.status))
		versions = await response.json()
	} catch {
		versionMenu.innerHTML = `<div class="menu-title">${isDeployed ? "couldn't load the list of versions" : "a local build: versions are listed on the site"}</div>`
			+ `<a href="https://github.com/gggscript/deceptive-search/commit/${buildCommit}">commit ${buildCommit.slice(0, 7)} on GitHub</a>`
		return
	}
	const link = (folder: string) => `../${folder}/${location.hash}`
	versionMenu.innerHTML = `<a href="${link("latest")}" class="${isLatest ? "current" : ""}"><b>latest</b><span class="muted">${escapeHtml(versions[0]?.commit.slice(0, 7) ?? "")}</span></a>`
		+ versions.map((version) => `<a href="${link(version.commit)}" class="${!isLatest && version.commit === buildCommit ? "current" : ""}" title="${escapeHtml(version.message)}">`
			+ `<code>${escapeHtml(version.commit.slice(0, 7))}</code><span class="muted">${escapeHtml(version.date)}</span><span class="message">${escapeHtml(version.message)}</span></a>`).join("")
}
function closeVersionMenu() {
	versionMenu.hidden = true
	versionButton.setAttribute("aria-expanded", "false")
}
versionButton.addEventListener("click", () => (versionMenu.hidden ? openVersionMenu() : closeVersionMenu()))
document.addEventListener("mousedown", (event) => {
	if (!versionMenu.hidden && !versionMenu.contains(event.target as Node) && !versionButton.contains(event.target as Node)) closeVersionMenu()
})
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") closeVersionMenu()
})

// Keyboard shortcuts: a popover from the status bar, or press "?".
const KEYBOARD_ICON = lucide(`<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>`)
const shortcutsButton = element<HTMLButtonElement>("shortcuts")
const shortcutsPopover = element("shortcuts-popover")
shortcutsButton.innerHTML = KEYBOARD_ICON
function setShortcutsOpen(isOpen: boolean) {
	shortcutsPopover.hidden = !isOpen
	shortcutsButton.setAttribute("aria-expanded", String(isOpen))
}
shortcutsButton.addEventListener("click", () => setShortcutsOpen(shortcutsPopover.hidden === true))
document.addEventListener("mousedown", (event) => {
	if (!shortcutsPopover.hidden && !shortcutsPopover.contains(event.target as Node) && !shortcutsButton.contains(event.target as Node)) setShortcutsOpen(false)
})
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") setShortcutsOpen(false)
	else if (event.key === "?" && !(event.target as Element).closest("input, select")) setShortcutsOpen(shortcutsPopover.hidden === true)
})

// Switching tabs within a group may not count as a layout change.
dock.onDidActivePanelChange(() => {
	renderActivityBar()
	if (isSweepStale && isSweepVisible()) renderSweep()
})

dock.onDidLayoutChange(() => {
	renderActivityBar()
	if (isSweepStale && isSweepVisible()) renderSweep()
	try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(dock.toJSON())) } catch {}
})

/* ---------- start ---------- */

loadLayout()
renderActivityBar()

const initialPosition = new URLSearchParams(location.hash.slice(1))
element<HTMLInputElement>("show-all-calls").checked = initialPosition.get("allCalls") === "1"
state.selectedStepIndex = Math.max(0, Number(initialPosition.get("step") ?? 1) - 1)
const initialRowPath = (initialPosition.get("row") ?? "").split(".").filter(Boolean).map(Number)
applyTheme()
renderParameterInputs()
renderSweepControls()
setParameters(state.parameters)
selectRowAtPath(initialRowPath)
