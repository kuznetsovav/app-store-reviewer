#!/usr/bin/env node
const [, , command, ...args] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case "spike": {
      const { runSpike } = await import("./spike.js");
      await runSpike(args);
      return;
    }
    case "scan":
    case "report":
    case "run":
      console.error(`'${command}' is not built yet (see later prompts).`);
      process.exit(2);
    default:
      console.error("Usage: tsx src/cli.ts <spike|scan|report|run> [options]");
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
