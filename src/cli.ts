#!/usr/bin/env node
const [, , command, ...args] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case "spike": {
      const { runSpike } = await import("./spike.js");
      await runSpike(args);
      return;
    }
    case "scan": {
      const { scanCommand } = await import("./scan/commands.js");
      await scanCommand(args);
      return;
    }
    case "status": {
      const { statusCommand } = await import("./scan/commands.js");
      statusCommand();
      return;
    }
    case "report": {
      const { reportCommand } = await import("./report/commands.js");
      reportCommand(args);
      return;
    }
    case "run": {
      const { runCommand } = await import("./report/commands.js");
      await runCommand(args);
      return;
    }
    default:
      console.error(
        [
          "Usage: tsx src/cli.ts <command> [options]",
          "  spike [--seed ID]                                   feasibility measurements",
          "  scan [--dry-run] [--max-calls N] [--seed ID] [--new] scan for new apps (resumes today's run)",
          "  status                                              last 5 runs and the frontier",
          "  report [--date YYYY-MM-DD]                          write reports/ from the database (no API calls)",
          "  run [scan options]                                  scan, then report; exit 1 if the scan aborted",
        ].join("\n"),
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
