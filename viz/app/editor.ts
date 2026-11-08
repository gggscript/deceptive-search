/// <reference lib="dom" />
// The code panels' editor: Monaco, the editor of VS Code, loaded from a CDN the first time a code panel shows
// (it's a few MB, and most visits never open one). TypeScript's language service, which Monaco runs in a worker,
// gives hovers with types and go to definition. TypeScript only shows /** */ comments, and this code uses //
// comments, so a second hover adds the // comment above (or after) the definition.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Monaco = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CodeEditor = any

const MONACO_BASE = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/"
const FONT = 'ui-monospace, "Cascadia Mono", Consolas, monospace'

let monacoPromise: Promise<Monaco> | null = null
let monaco: Monaco = null
// Where go to definition into another file goes (set by the page).
let openDefinition: (file: string, line: number, inNewTab: boolean) => void = () => {}

export const isEditorLoaded = () => monaco !== null

// Resolves once Monaco is loaded and the core files are models it knows (so imports and definitions resolve).
export function loadEditor(sources: Record<string, string>, onOpenDefinition: typeof openDefinition): Promise<Monaco> {
	openDefinition = onOpenDefinition
	monacoPromise ??= new Promise((resolve, reject) => {
		// Monaco's workers (the TypeScript service) from the CDN: a same-origin blob that imports them, which also works from file://.
		;(window as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
			getWorkerUrl: () => URL.createObjectURL(new Blob([`self.MonacoEnvironment = { baseUrl: "${MONACO_BASE}" }; importScripts("${MONACO_BASE}vs/base/worker/workerMain.js")`], { type: "text/javascript" })),
		}
		const script = document.createElement("script")
		script.src = `${MONACO_BASE}vs/loader.js`
		script.onerror = () => reject(new Error("couldn't load the editor"))
		script.onload = () => {
			const amdRequire = (window as unknown as { require: { config: (options: unknown) => void } & ((modules: string[], onLoad: () => void, onError: (error: unknown) => void) => void) }).require
			amdRequire.config({ paths: { vs: `${MONACO_BASE}vs` } })
			amdRequire(["vs/editor/editor.main"], () => {
				monaco = (window as unknown as { monaco: Monaco }).monaco
				setUp(sources)
				resolve(monaco)
			}, reject)
		}
		document.head.append(script)
	})
	return monacoPromise
}

function setUp(sources: Record<string, string>) {
	const typescript = monaco.languages.typescript
	typescript.typescriptDefaults.setCompilerOptions({
		target: typescript.ScriptTarget.ESNext,
		module: typescript.ModuleKind.ESNext,
		moduleResolution: typescript.ModuleResolutionKind.NodeJs,
		strict: true,
		noEmit: true,
		allowNonTsExtensions: true,
	})
	// Read-only code that compiles: errors would only be noise from what the browser can't see (e.g. Bun's types).
	typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true })
	typescript.typescriptDefaults.setEagerModelSync(true)
	for (const [file, source] of Object.entries(sources)) monaco.editor.createModel(source, "typescript", monaco.Uri.parse(`file:///${file}`))

	// VS Code's themes on the page's backgrounds.
	monaco.editor.defineTheme("page-light", { base: "vs", inherit: true, rules: [], colors: { "editor.background": "#ffffff" } })
	monaco.editor.defineTheme("page-dark", { base: "vs-dark", inherit: true, rules: [], colors: { "editor.background": "#0d1117" } })

	monaco.languages.registerHoverProvider("typescript", { provideHover: commentHover })
	// Go to definition (Ctrl+click, F12) into another file: the page opens that file's tab.
	monaco.editor.registerEditorOpener({
		openCodeEditor(_source: unknown, resource: { path: string }, selectionOrPosition?: { startLineNumber?: number; lineNumber?: number }) {
			openDefinition(resource.path.replace(/^\//, ""), selectionOrPosition?.startLineNumber ?? selectionOrPosition?.lineNumber ?? 1, false)
			return true
		},
	})
}

async function definitionAt(model: Monaco, position: Monaco) {
	const getWorker = await monaco.languages.typescript.getTypeScriptWorker()
	const client = await getWorker(model.uri)
	const definitions = await client.getDefinitionAtPosition(model.uri.toString(), model.getOffsetAt(position))
	const definition = definitions?.[0]
	if (!definition) return null
	const target = monaco.editor.getModel(monaco.Uri.parse(definition.fileName))
	if (!target) return null
	return { model: target, file: target.uri.path.replace(/^\//, "") as string, line: target.getPositionAt(definition.textSpan.start).lineNumber as number }
}

// The // comment lines right above a definition, and a // comment at the end of its own line.
function commentOf(model: Monaco, line: number) {
	const above: string[] = []
	for (let index = line - 1; index >= 1; index--) {
		const match = (model.getLineContent(index) as string).match(/^\s*\/\/\s?(.*)$/)
		if (!match) break
		above.unshift(match[1]!)
	}
	const trailing = (model.getLineContent(line) as string).match(/\S.*?\s\/\/\s?(.*)$/)?.[1]
	return [...above, ...(trailing ? [trailing] : [])]
}

async function commentHover(model: Monaco, position: Monaco) {
	const word = model.getWordAtPosition(position)
	if (!word) return null
	const definition = await definitionAt(model, position)
	if (!definition) return null
	const lines = commentOf(definition.model, definition.line)
	if (!lines.length) return null
	// Keep the comment's own line breaks (markdown needs two spaces for them), and say where it is.
	const escapeMarkdown = (text: string) => text.replace(/([\\`*_{}[\]<>#|])/g, "\\$1")
	return {
		range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
		contents: [{ value: lines.map(escapeMarkdown).join("  \n") }, { value: `*${definition.file}:${definition.line}*` }],
	}
}

export function setEditorTheme(isDark: boolean) {
	monaco?.editor.setTheme(isDark ? "page-dark" : "page-light")
}

// A read-only editor showing `file`. Right-click → "Open Definition in New Tab".
export function createEditor(container: HTMLElement, file: string, isDark: boolean): CodeEditor {
	const editor = monaco.editor.create(container, {
		model: monaco.editor.getModel(monaco.Uri.parse(`file:///${file}`)),
		theme: isDark ? "page-dark" : "page-light",
		readOnly: true,
		domReadOnly: true,
		automaticLayout: true,
		minimap: { enabled: false },
		scrollBeyondLastLine: true, // so a function near the end of a file can still be scrolled to the top
		fontFamily: FONT,
		fontSize: 12.5,
		lineHeight: 19,
		lineNumbersMinChars: 3,
		renderLineHighlight: "none",
		fixedOverflowWidgets: true, // hovers can leave the panel
		stickyScroll: { enabled: true },
		tabSize: 2,
		wordWrap: "off",
	})
	editor.addAction({
		id: "open-definition-in-new-tab",
		label: "Open Definition in New Tab",
		contextMenuGroupId: "navigation",
		contextMenuOrder: 1.05,
		run: async (target: CodeEditor) => {
			const definition = await definitionAt(target.getModel(), target.getPosition())
			if (definition) openDefinition(definition.file, definition.line, true)
		},
	})
	return editor
}

export function revealLine(editor: CodeEditor, line: number, { atTop = false } = {}) {
	if (atTop) editor.setScrollTop(editor.getTopForLineNumber(line))
	else editor.revealLineInCenter(line)
	editor.setPosition({ lineNumber: line, column: 1 })
}

// Runtime values under lines (view zones), the shown function highlighted and the lines it didn't run dimmed.
export type LineValues = { afterLine: number; html: string; indentCharacters: number }
type FunctionRange = { firstLine: number; lastLine: number; skippedLines: number[] }
type Shown = { zoneIds: string[]; decorations: Monaco; range: FunctionRange; values: LineValues[]; onValueClick: (element: HTMLElement) => void; width: number }
const shown = new WeakMap<CodeEditor, Shown>()
const watchedEditors = new WeakSet<CodeEditor>()

// Values wrap to the editor's width, so their boxes are measured again when it changes (scrolling only if the
// editor had no size before, i.e. its panel just opened).
function watchWidth(editor: CodeEditor) {
	if (watchedEditors.has(editor)) return
	watchedEditors.add(editor)
	editor.onDidLayoutChange(() => {
		const last = shown.get(editor)
		const width = editor.getLayoutInfo().contentWidth as number
		if (last && Math.abs(width - last.width) > 8) showFunction(editor, last.range, last.values, last.onValueClick, { scroll: last.width < 50 })
	})
}

export function showFunction(editor: CodeEditor, range: FunctionRange, values: LineValues[], onValueClick: (element: HTMLElement) => void, { scroll = true } = {}) {
	watchWidth(editor)
	const previous = shown.get(editor)
	const zoneIds: string[] = []
	const characterWidth = editor.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth as number
	const width = editor.getLayoutInfo().contentWidth as number
	editor.changeViewZones((accessor: Monaco) => {
		for (const id of previous?.zoneIds ?? []) accessor.removeZone(id)
		for (const value of values) {
			const domNode = document.createElement("div")
			domNode.className = "code-values-zone"
			const box = document.createElement("div")
			box.className = "values"
			box.style.marginLeft = `${value.indentCharacters * characterWidth}px`
			box.style.maxWidth = `${Math.max(120, width - value.indentCharacters * characterWidth - 20)}px`
			box.innerHTML = value.html
			domNode.append(box)
			// The zone's height: the box measured at the width it will have.
			const measure = document.createElement("div")
			measure.className = "code-values-zone"
			measure.style.cssText = `position: absolute; visibility: hidden; width: ${width}px`
			measure.append(box.cloneNode(true))
			document.body.append(measure)
			const height = measure.offsetHeight
			measure.remove()
			box.addEventListener("mousedown", (event) => event.stopPropagation())
			box.addEventListener("click", (event) => {
				const link = (event.target as Element).closest<HTMLElement>(".call")
				if (link) onValueClick(link)
			})
			zoneIds.push(accessor.addZone({ afterLineNumber: value.afterLine, heightInPx: height + 2, domNode, suppressMouseDown: true }))
		}
	})
	// The shown function gets a tinted background; the lines it didn't run, dimmed text.
	const model = editor.getModel()
	const decorations: { range: Monaco; options: Monaco }[] = []
	for (let line = range.firstLine; line <= range.lastLine; line++) {
		decorations.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "code-line-shown" } })
		if (range.skippedLines.includes(line)) decorations.push({ range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)), options: { inlineClassName: "code-line-skipped" } })
	}
	previous?.decorations?.clear()
	shown.set(editor, { zoneIds, decorations: editor.createDecorationsCollection(decorations), range, values, onValueClick, width })
	// Scroll the function to the top; again a frame later, when a panel that just opened has its size.
	if (scroll) {
		const reveal = () => revealLine(editor, range.firstLine, { atTop: true })
		reveal()
		requestAnimationFrame(reveal)
	}
}

// Show `file` in `editor` (the Code panel switches files as the selected call changes).
export function showFile(editor: CodeEditor, file: string) {
	const model = monaco.editor.getModel(monaco.Uri.parse(`file:///${file}`))
	if (editor.getModel() !== model) editor.setModel(model)
}
