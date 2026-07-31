// The simulation harness runs under vite-node, not the browser. Declaring just the one
// global it needs keeps `tsc --noEmit` clean without pulling in all of @types/node.
declare const process: { argv: string[] };
