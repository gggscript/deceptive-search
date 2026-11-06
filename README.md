# deceptive-search

A toy model of training: an **agent** and a **trainer** act on a tiny world (a banana count, both
targets and search depths). Each chooses by tree search, and predicts every later move, its own
included, by running the mover's own search. The question is when such an agent resists, games
or deceives its trainer.

**Try it:** https://deceptive-search.gustaf.website/ (the latest build; links like
`/visualization/<commit>/#<parameters>` show a given commit with given settings).

- `core/world.ts`: the world, the actors and their actions
- `core/search.ts`: the search (one argmax over the actor's own actions, then predicted moves)
- `viz/`: the interactive page; it runs the real core code, instrumented to record and cache calls

```sh
bun install
bun index.ts          # print a run in the terminal (flags: --agentSearchDepth=3 --stepCount=10 …)
bun viz/build.ts      # build viz/out/index.html, then open it in a browser
bun run deploy        # publish the last commit to the site above
```
