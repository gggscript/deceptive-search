// Builds the interactive page: bun viz/build.ts   → viz/out/index.html (open it in a browser)
// The page runs the real core code, instrumented by viz/instrument.ts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { instrumentCorePlugin } from "./instrument"

const vizDirectory = import.meta.dir
const projectDirectory = join(vizDirectory, "..")

const build = await Bun.build({
	entrypoints: [join(vizDirectory, "app", "main.ts")],
	plugins: [instrumentCorePlugin],
	target: "browser",
})
if (!build.success) {
	for (const log of build.logs) console.error(log)
	process.exit(1)
}
const bundle = await build.outputs[0]!.text()

// The worker runs the searches off the main thread; the page starts it from this source (one file, no server).
const workerBuild = await Bun.build({ entrypoints: [join(vizDirectory, "app", "worker.ts")], plugins: [instrumentCorePlugin], target: "browser" })
if (!workerBuild.success) {
	for (const log of workerBuild.logs) console.error(log)
	process.exit(1)
}
const workerSource = await workerBuild.outputs[0]!.text()

// The commit this page is built from, for permalinks. "Dirty": built with uncommitted changes.
const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: projectDirectory }).stdout.toString().trim()
const buildCommit = git("rev-parse", "--short=10", "HEAD")
const buildIsDirty = git("status", "--porcelain") !== ""

const coreSources = Object.fromEntries(["core/search.ts", "core/world.ts"].map((file) => [file, readFileSync(join(projectDirectory, file), "utf8")]))
const dockviewCss = readFileSync(join(projectDirectory, "node_modules", "dockview", "dist", "styles", "dockview.css"), "utf8")
const page = readFileSync(join(vizDirectory, "app", "index.html"), "utf8")
	.replace("/*DOCKVIEW_CSS*/", () => dockviewCss.replaceAll("</", "<\/"))
	.replace("/*CORE_SOURCES*/", () => `const coreSources = ${JSON.stringify(coreSources).replaceAll("</", "<\\/")}; const buildCommit = ${JSON.stringify(buildCommit)}; const buildIsDirty = ${buildIsDirty}; const workerSource = ${JSON.stringify(workerSource).replaceAll("</", "<\\/")}`)
	.replace("/*BUNDLE*/", () => bundle.replaceAll("</script", "<\\/script"))

mkdirSync(join(vizDirectory, "out"), { recursive: true })
const outputPath = join(vizDirectory, "out", "index.html")
writeFileSync(outputPath, page)
console.log(`wrote ${outputPath}`)
