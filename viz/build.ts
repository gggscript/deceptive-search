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

const coreSources = Object.fromEntries(["core/search.ts", "core/world.ts"].map((file) => [file, readFileSync(join(projectDirectory, file), "utf8")]))
const page = readFileSync(join(vizDirectory, "app", "index.html"), "utf8")
	.replace("/*CORE_SOURCES*/", () => `const coreSources = ${JSON.stringify(coreSources).replaceAll("</", "<\\/")}`)
	.replace("/*BUNDLE*/", () => bundle.replaceAll("</script", "<\\/script"))

mkdirSync(join(vizDirectory, "out"), { recursive: true })
const outputPath = join(vizDirectory, "out", "index.html")
writeFileSync(outputPath, page)
console.log(`wrote ${outputPath}`)
